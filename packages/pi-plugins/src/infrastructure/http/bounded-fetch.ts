import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import type {
  ApprovedNetworkTarget,
  NetworkEgressPolicy,
} from "../network/network-egress-policy.js";

/** A response body exposed as bytes only; callers must consume it exactly once. */
export type BoundedFetchResponse = Readonly<{
  status: number;
  headers: Headers;
  url: string;
  body: AsyncIterable<Uint8Array>;
}>;

export type BoundedFetchRequest = Readonly<{
  url: string;
  maxBytes: number;
  signal: AbortSignal;
  /** Internal adapter override; never included in a response or source result. */
  credentials?: NpmCredentialProvider;
}>;

export interface BoundedFetch {
  request(request: BoundedFetchRequest): Promise<BoundedFetchResponse>;
}

/**
 * Credentials are applied to a private Headers object owned by the HTTP
 * adapter. The provider deliberately has no return value, so a token cannot
 * accidentally become part of a resolved source or an application result.
 */
export type NpmCredentialProvider = Readonly<{
  apply(url: URL, headers: Headers, signal: AbortSignal): void | Promise<void>;
}> | ((url: URL, headers: Headers, signal: AbortSignal) => void | Promise<void>);

export type BoundedFetchOptions = Readonly<{
  /** Trusted test/host adapter. Production uses the DNS-pinned Node HTTPS path. */
  fetch?: typeof globalThis.fetch;
  credentials: NpmCredentialProvider;
  egress: NetworkEgressPolicy;
  maxRedirects?: number;
}>;

export type BoundedFetchErrorKind = "network" | "policy" | "credential" | "redirect" | "response" | "limit";

/** Errors contain only safe classification data; the requested URL is not retained. */
export class BoundedFetchError extends Error {
  readonly kind: BoundedFetchErrorKind;
  readonly status?: number;

  constructor(input: Readonly<{
    kind: BoundedFetchErrorKind;
    message: string;
    status?: number;
    cause?: unknown;
  }>) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "BoundedFetchError";
    this.kind = input.kind;
    if (input.status !== undefined) this.status = input.status;
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function applyCredentials(
  provider: NpmCredentialProvider,
  url: URL,
  headers: Headers,
  signal: AbortSignal,
): Promise<void> {
  if (typeof provider === "function") return Promise.resolve(provider(url, headers, signal));
  if (typeof provider.apply !== "function") throw new TypeError("npm credential provider must apply credentials");
  return Promise.resolve(provider.apply(url, headers, signal));
}

function bodyFromResponse(response: Response, maxBytes: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
  if (response.body === null) {
    return (async function* empty(): AsyncGenerator<Uint8Array> {
      throwIfAborted(signal);
    })();
  }

  return (async function* stream(): AsyncGenerator<Uint8Array> {
    const reader = response.body!.getReader();
    let total = 0;
    try {
      while (true) {
        throwIfAborted(signal);
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch (error) {
          if (signal.aborted) throw abortError(signal);
          throw new BoundedFetchError({ kind: "network", message: "HTTP response stream failed", cause: error });
        }
        if (next.done) return;
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array)) {
          throw new BoundedFetchError({ kind: "response", message: "HTTP response body was not bytes" });
        }
        total += chunk.byteLength;
        if (total > maxBytes) {
          throw new BoundedFetchError({ kind: "limit", message: "HTTP response exceeded its byte limit" });
        }
        if (chunk.byteLength > 0) yield new Uint8Array(chunk);
      }
    } finally {
      // Cancellation and parser failures must stop a slow or hostile server
      // even when the consumer does not finish iterating the body.
      await reader.cancel().catch(() => undefined);
    }
  })();
}

function location(response: Response): string | undefined {
  const value = response.headers.get("location");
  return value === null || value.length === 0 ? undefined : value;
}

function safeUrl(input: string): URL {
  let value: URL;
  try {
    value = new URL(input);
  } catch (error) {
    throw new BoundedFetchError({ kind: "redirect", message: "HTTP URL is invalid", cause: error });
  }
  if (value.protocol !== "https:") {
    throw new BoundedFetchError({ kind: "redirect", message: "HTTP URL must use HTTPS" });
  }
  if (value.username !== "" || value.password !== "") {
    throw new BoundedFetchError({ kind: "redirect", message: "HTTP URL contains credentials" });
  }
  return value;
}

function pinnedLookup(target: ApprovedNetworkTarget): LookupFunction {
  return ((
    _hostname: string,
    options: unknown,
    callback: (...args: unknown[]) => void,
  ) => {
    if (options !== null && typeof options === "object" && "all" in options && options.all === true) {
      callback(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  }) as unknown as LookupFunction;
}

function appendResponseHeaders(target: Headers, source: import("node:http").IncomingHttpHeaders): void {
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) for (const item of value) target.append(name, item);
    else if (value !== undefined) target.append(name, value);
  }
}

function requestPinnedHttps(
  target: ApprovedNetworkTarget,
  headers: Headers,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target.url, {
      method: "GET",
      headers: Object.fromEntries(headers.entries()),
      lookup: pinnedLookup(target),
      servername: target.hostname,
      signal,
    }, (incoming) => {
      const responseHeaders = new Headers();
      appendResponseHeaders(responseHeaders, incoming.headers);
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
        status: incoming.statusCode ?? 500,
        ...(incoming.statusMessage === undefined ? {} : { statusText: incoming.statusMessage }),
        headers: responseHeaders,
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function discard(response: Response, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  try {
    await response.body?.cancel();
  } catch {
    // The redirect target is authoritative; a body that is already closed does
    // not change the redirect decision.
  }
}

export function createBoundedFetch(options: BoundedFetchOptions): BoundedFetch {
  if (options?.fetch !== undefined && typeof options.fetch !== "function") throw new TypeError("bounded fetch adapter is invalid");
  if (options.credentials === null || options.credentials === undefined) {
    throw new TypeError("bounded fetch requires a credential provider");
  }
  if (options.egress === null || typeof options.egress?.origin !== "function" ||
      typeof options.egress.authorize !== "function" || typeof options.egress.redirectAllowed !== "function") {
    throw new TypeError("bounded fetch requires an egress policy");
  }
  const maxRedirects = options.maxRedirects ?? 5;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new TypeError("maxRedirects must be a nonnegative safe integer");
  }

  return {
    async request(input) {
      if (input === null || typeof input !== "object") throw new TypeError("bounded fetch request is required");
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new TypeError("bounded fetch maxBytes must be positive");
      }
      if (typeof input.signal?.aborted !== "boolean") throw new TypeError("bounded fetch requires an AbortSignal");
      throwIfAborted(input.signal);

      let current = safeUrl(input.url);
      let initialOrigin: string | undefined;
      for (let redirects = 0; ; redirects += 1) {
        throwIfAborted(input.signal);
        let candidateOrigin: string;
        try {
          candidateOrigin = options.egress.origin(current.toString());
        } catch (error) {
          throw new BoundedFetchError({ kind: "policy", message: "HTTP destination authority is invalid", cause: error });
        }
        initialOrigin ??= candidateOrigin;
        if (!options.egress.redirectAllowed(initialOrigin, candidateOrigin)) {
          throw new BoundedFetchError({ kind: "redirect", message: "HTTP redirect changed authority" });
        }
        let target: ApprovedNetworkTarget;
        try {
          target = await options.egress.authorize(current.toString(), "https:");
        } catch (error) {
          if (input.signal.aborted) throw abortError(input.signal);
          throw new BoundedFetchError({ kind: "policy", message: "HTTP destination is not permitted", cause: error });
        }
        const headers = new Headers({ accept: "application/json, application/octet-stream" });
        if (target.credentialsApproved) {
          try {
            await applyCredentials(input.credentials ?? options.credentials, current, headers, input.signal);
          } catch (error) {
            if (input.signal.aborted) throw abortError(input.signal);
            throw new BoundedFetchError({ kind: "credential", message: "HTTP credential adapter failed", cause: error });
          }
        }
        let response: Response;
        try {
          response = options.fetch === undefined
            ? await requestPinnedHttps(target, headers, input.signal)
            : await options.fetch(current, {
                method: "GET",
                headers,
                redirect: "manual",
                signal: input.signal,
              });
        } catch (error) {
          if (input.signal.aborted) throw abortError(input.signal);
          throw new BoundedFetchError({ kind: "network", message: "HTTP request failed", cause: error });
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          const target = location(response);
          await discard(response, input.signal);
          if (target === undefined) {
            throw new BoundedFetchError({ kind: "redirect", message: "HTTP redirect has no location" });
          }
          if (redirects >= maxRedirects) {
            throw new BoundedFetchError({ kind: "redirect", message: "HTTP redirect limit exceeded" });
          }
          let next: URL;
          try {
            next = new URL(target, current);
          } catch (error) {
            throw new BoundedFetchError({ kind: "redirect", message: "HTTP redirect location is invalid", cause: error });
          }
          // Rebuilding the request on every hop means Authorization is never
          // forwarded implicitly. The provider may elect to authorize the new
          // origin, but application code never sees those headers.
          current = safeUrl(next.toString());
          continue;
        }

        return {
          status: response.status,
          headers: response.headers,
          url: current.toString(),
          body: bodyFromResponse(response, input.maxBytes, input.signal),
        };
      }
    },
  };
}

type NpmConfigCredential = Readonly<{
  scope: string;
  token?: string;
  basic?: string;
}>;

function parseNpmrc(text: string): NpmConfigCredential[] {
  const result: NpmConfigCredential[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (value.length === 0) continue;
    if (key.endsWith(":_authToken")) {
      // npm's standard token form is `//host[:port]/path/:_authToken`.
      // Parse the whole authority plus path rather than stopping at the first
      // slash, so scoped registries and non-default ports remain distinct.
      const scope = key.slice(0, -":_authToken".length);
      try {
        const parsed = new URL(`https:${scope}`);
        if (
          !scope.startsWith("//") || !scope.endsWith("/") ||
          parsed.hostname.length === 0 || parsed.username !== "" || parsed.password !== "" ||
          parsed.search !== "" || parsed.hash !== ""
        ) continue;
        result.push({ scope, token: value });
      } catch {
        // Ignore malformed npmrc keys. They cannot authorize a request, while
        // unreadable files remain an explicit credential adapter failure.
      }
      continue;
    }
    if (key === "_auth") result.push({ scope: "//registry.npmjs.org/", basic: value });
  }
  return result;
}

function credentialScopeLength(scope: string, url: URL): number | undefined {
  try {
    if (url.protocol !== "https:") return undefined;
    const scoped = new URL(`https:${scope}`);
    const scopedPort = scoped.port || "443";
    const requestPort = url.port || "443";
    if (scoped.hostname.toLowerCase() !== url.hostname.toLowerCase() || scopedPort !== requestPort) return undefined;
    // Scope paths are directory prefixes. Requiring the trailing slash from
    // npmrc prevents `/team/` from authorizing `/teamwork/...`.
    if (!url.pathname.startsWith(scoped.pathname)) return undefined;
    return scoped.pathname.length;
  } catch {
    return undefined;
  }
}

function credentialApplies(scope: string, url: URL): boolean {
  return credentialScopeLength(scope, url) !== undefined;
}

/**
 * Minimal npmrc reader for the standard token/basic auth forms. It is kept in
 * the HTTP adapter so parsed credentials never cross into source contracts.
 */
export function createNpmCredentialProvider(options: Readonly<{
  configPath?: string;
  configText?: string;
  home?: string;
}> = {}): NpmCredentialProvider {
  let loaded: Promise<readonly NpmConfigCredential[]> | undefined;
  const readConfig = async (): Promise<readonly NpmConfigCredential[]> => {
    if (options.configText !== undefined) return parseNpmrc(options.configText);
    const path = options.configPath ?? process.env.NPM_CONFIG_USERCONFIG ?? join(options.home ?? homedir(), ".npmrc");
    try {
      return parseNpmrc(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      // An unreadable credential file is not equivalent to an empty one: the
      // caller must be able to distinguish configuration failure from a
      // genuinely anonymous request. Keep the path and contents out of the
      // error; the cause remains adapter-local.
      throw new BoundedFetchError({ kind: "credential", message: "npm credential configuration could not be read", cause: error });
    }
  };
  return {
    async apply(url, headers, signal) {
      throwIfAborted(signal);
      loaded ??= readConfig();
      const credentials = await loaded;
      const match = credentials
        .filter((entry) => credentialApplies(entry.scope, url))
        .sort((left, right) => (credentialScopeLength(right.scope, url) ?? -1) - (credentialScopeLength(left.scope, url) ?? -1))[0];
      if (match?.token !== undefined) headers.set("authorization", `Bearer ${match.token}`);
      else if (match?.basic !== undefined) headers.set("authorization", `Basic ${match.basic}`);
    },
  };
}

export const createDefaultNpmCredentialProvider = createNpmCredentialProvider;

/** A byte collector used by adapters that need bounded JSON rather than a stream. */
export async function collectBoundedBytes(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be positive");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    throwIfAborted(signal);
    if (!(chunk instanceof Uint8Array)) throw new BoundedFetchError({ kind: "response", message: "HTTP response body was not bytes" });
    length += chunk.byteLength;
    if (length > maxBytes) throw new BoundedFetchError({ kind: "limit", message: "HTTP response exceeded its byte limit" });
    chunks.push(chunk);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new BoundedFetchError({ kind: "response", message: "HTTP response was not valid UTF-8", cause: error });
  }
}

