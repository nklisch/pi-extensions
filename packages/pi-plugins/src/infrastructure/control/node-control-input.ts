import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import type { Readable } from "node:stream";
import { SensitiveValue } from "../../application/sensitive-value.js";
import type {
  NativeControlExactDecision,
  NativeControlInputIssue,
  NativeControlInputPort,
  NativeControlInputRequest,
  NativeControlInputResult,
} from "../../application/ports/native-control-input.js";

const DEFAULT_MAX_BYTES = 1_048_576;

type InputDocument = Readonly<{
  expected?: Readonly<Record<string, unknown>>;
  values?: Readonly<Record<string, unknown>>;
  decision?: unknown;
}>;

export type NodeControlInputOptions = Readonly<{
  stdin?: Readable;
  environment?: NodeJS.ProcessEnv;
  uid?: number;
  maxBytes?: number;
}>;

const issue = (code: NativeControlInputIssue["code"], key?: string): NativeControlInputIssue => Object.freeze({ code, ...(key === undefined ? {} : { key }) });
const invalid = (...issues: NativeControlInputIssue[]): NativeControlInputResult => Object.freeze({ kind: "invalid" as const, issues: Object.freeze(issues) });

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function parseDocument(bytes: Uint8Array): InputDocument | NativeControlInputResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid(issue("INPUT_DOCUMENT_INVALID"));
  }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { return invalid(issue("INPUT_DOCUMENT_INVALID")); }
  if (!plainRecord(value) || Object.keys(value).some((key) => !["expected", "values", "decision"].includes(key)) ||
      (value.expected !== undefined && !plainRecord(value.expected)) ||
      (value.values !== undefined && !plainRecord(value.values))) return invalid(issue("INPUT_DOCUMENT_INVALID"));
  return value as InputDocument;
}

function exactExpected(request: NativeControlInputRequest, document: InputDocument): boolean {
  const expected = document.expected;
  for (const [key, value] of Object.entries(request.expected)) {
    if (value === undefined) continue;
    const provided = expected?.[key];
    if (plainRecord(value)) {
      if (!plainRecord(provided) || JSON.stringify(provided) !== JSON.stringify(value)) return false;
    } else if (provided !== value) return false;
  }
  return true;
}

function parseDecision(request: NativeControlInputRequest, value: unknown): NativeControlExactDecision | undefined {
  if (!plainRecord(value) || typeof value.kind !== "string") return undefined;
  if ((value.kind === "grant" || value.kind === "deny") && (value.consentId === undefined || typeof value.consentId === "string")) {
    return value.kind === "grant" && typeof value.consentId === "string"
      ? { kind: "grant", consentId: value.consentId }
      : { kind: "deny", ...(typeof value.consentId === "string" ? { consentId: value.consentId } : {}) };
  }
  if (value.kind === "confirm" && Object.keys(value).length === 1) return { kind: "confirm" };
  if (value.kind === "uninstall" && (value.persistentData === "keep" || value.persistentData === "delete-confirmed")) return { kind: "uninstall", persistentData: value.persistentData };
  if (value.kind === "project-sync" && Array.isArray(value.resolutions)) return { kind: "project-sync", resolutions: value.resolutions as never };
  if (request.consent === undefined && request.expected.consentId === undefined && value.kind === "deny") return { kind: "deny" };
  return undefined;
}

function supply(request: NativeControlInputRequest, document: InputDocument): NativeControlInputResult {
  if (!exactExpected(request, document)) return invalid(issue("INPUT_EXPECTATION_STALE"));
  const values = document.values ?? {};
  const known = new Set(request.fields.map((field) => field.key));
  const unknown = Object.keys(values).filter((key) => !known.has(key)).map((key) => issue("INPUT_UNKNOWN_KEY", key));
  if (unknown.length > 0) return invalid(...unknown);
  const nonSensitive: Array<Readonly<{ key: string; value: unknown }>> = [];
  const sensitive: Array<Readonly<{ key: string; value: SensitiveValue }>> = [];
  for (const field of request.fields) {
    if (!(field.key in values)) continue;
    if (field.sensitive) sensitive.push(Object.freeze({ key: field.key, value: SensitiveValue.fromUnknown(values[field.key]) }));
    else nonSensitive.push(Object.freeze({ key: field.key, value: values[field.key] }));
  }
  const decision = parseDecision(request, document.decision);
  if (decision === undefined) return invalid(issue("INPUT_DECISION_REQUIRED"));
  return Object.freeze({ kind: "supplied" as const, nonSensitive: Object.freeze(nonSensitive), sensitive: Object.freeze(sensitive), decision: Object.freeze(decision) });
}

function readStdin(stream: Readable, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | NativeControlInputResult> {
  signal.throwIfAborted();
  if ((stream as Readable & { isTTY?: boolean }).isTTY === true) {
    return Promise.resolve(Object.freeze({ kind: "unavailable" as const, code: "NO_TTY" as const }));
  }
  if (stream.readableEnded) return Promise.resolve(Buffer.alloc(0));

  return new Promise<Uint8Array | NativeControlInputResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const erase = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
      // Attaching a data listener resumes process.stdin. Return the shared
      // stream to a buffered idle state without destroy(), unshift(), or
      // claiming ownership of its lifetime.
      if (!stream.destroyed && !stream.readableEnded) stream.pause();
    };
    const succeed = (value: Uint8Array | NativeControlInputResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      erase();
      reject(error);
    };
    const onData = (value: Buffer | Uint8Array | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        erase();
        succeed(invalid(issue("INPUT_TOO_LARGE")));
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => {
      const bytes = Buffer.concat(chunks, total);
      erase();
      succeed(bytes);
    };
    const onError = (error: unknown) => fail(error);
    const onClose = () => succeed(invalid(issue("INPUT_DOCUMENT_INVALID")));
    const onAbort = () => fail(signal.reason ?? new DOMException("aborted", "AbortError"));

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    stream.resume();
    if (signal.aborted) onAbort();
  });
}

function safeFile(stats: Stats, uid: number | undefined, maxBytes: number): NativeControlInputResult | undefined {
  if (!stats.isFile() || (stats.mode & 0o077) !== 0 || (uid !== undefined && stats.uid !== uid)) return invalid(issue("INPUT_DOCUMENT_INVALID"));
  if (stats.size > maxBytes) return invalid(issue("INPUT_TOO_LARGE"));
  return undefined;
}

/** A non-prompting, single-consumer Node input adapter. */
export function createNodeControlInput(options: NodeControlInputOptions = {}): NativeControlInputPort {
  const stdin = options.stdin ?? process.stdin;
  const environment = options.environment ?? process.env;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let stdinConsumed = false;

  return Object.freeze({
    async collect(request: NativeControlInputRequest, signal: AbortSignal): Promise<NativeControlInputResult> {
      signal.throwIfAborted();
      if (request.channel.kind === "none") return Object.freeze({ kind: "unavailable", code: "NO_INPUT_CHANNEL" });
      if (request.channel.kind === "provided") return Object.freeze({ kind: "unavailable", code: "CHANNEL_UNSUPPORTED" });
      if (request.channel.kind === "environment") {
        if (request.fields.some((field) => field.sensitive) || request.consent !== undefined || request.expected.consentId !== undefined) {
          return Object.freeze({ kind: "unavailable", code: "SECRET_PROMPT_UNAVAILABLE" });
        }
        const values: Record<string, unknown> = {};
        for (const field of request.fields) {
          const name = `${request.channel.prefix}${field.key.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
          if (environment[name] !== undefined) values[field.key] = environment[name];
        }
        return supply(request, { expected: request.expected, values, decision: { kind: "confirm" } });
      }

      let bytes: Uint8Array | NativeControlInputResult;
      if (request.channel.kind === "stdin-json") {
        if (stdinConsumed) return Object.freeze({ kind: "unavailable", code: "CHANNEL_UNSUPPORTED" });
        stdinConsumed = true;
        bytes = await readStdin(stdin, maxBytes, signal);
      } else {
        let handle;
        try {
          handle = await open(request.channel.locator, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          const stats = await handle.stat();
          const unsafe = safeFile(stats, uid, maxBytes);
          if (unsafe !== undefined) return unsafe;
          bytes = await handle.readFile();
        } catch {
          return invalid(issue("INPUT_DOCUMENT_INVALID"));
        } finally {
          await handle?.close().catch(() => undefined);
        }
      }
      if (!(bytes instanceof Uint8Array)) return bytes;
      try {
        const document = parseDocument(bytes);
        if ("kind" in document) return document;
        return supply(request, document);
      } finally {
        bytes.fill(0);
      }
    },
  });
}
