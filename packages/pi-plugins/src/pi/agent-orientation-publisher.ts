import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AGENT_ORIENTATION_CUSTOM_TYPE,
  assembleUnavailableOrientation,
  type AgentOrientationContent,
} from "../application/agent-orientation.js";
import type { Sha256 } from "../domain/source.js";

export type AgentOrientationPublisher = Readonly<{
  publish(content: AgentOrientationContent, briefPath: string, context: ExtensionContext): Promise<void>;
  publishUnavailable(input: Readonly<{
    briefPath: string;
    code: string;
    packageVersion: string;
    sha256: Sha256;
    context: ExtensionContext;
  }>): Promise<void>;
}>;

type OrientationDetails = Readonly<{ factsDigest: string }>;

type SessionEntryLike = Readonly<{
  type?: unknown;
  customType?: unknown;
  details?: unknown;
}>;

function digestFrom(entry: SessionEntryLike): string | undefined {
  if (entry.type !== "custom_message" || entry.customType !== AGENT_ORIENTATION_CUSTOM_TYPE) return undefined;
  if (entry.details === null || typeof entry.details !== "object" || Array.isArray(entry.details)) return undefined;
  const digest = (entry.details as Partial<OrientationDetails>).factsDigest;
  return typeof digest === "string" ? digest : undefined;
}

function hasActiveDigest(context: ExtensionContext, digest: string): boolean {
  try {
    const manager = context.sessionManager as unknown as { buildContextEntries?: () => readonly unknown[] };
    // buildContextEntries is deliberately the only source here: getEntries()
    // includes abandoned branches and compacted-away messages, which would
    // suppress an orientation that is no longer in the model's active context.
    const entries = typeof manager.buildContextEntries === "function" ? manager.buildContextEntries() : [];
    return entries.some((entry) => digestFrom((entry ?? {}) as SessionEntryLike) === digest);
  } catch {
    return false;
  }
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Thin Pi adapter: active-context dedup, atomic brief replacement, and sendMessage. */
export function createAgentOrientationPublisher(input: Readonly<{ pi: Pick<ExtensionAPI, "sendMessage"> }>): AgentOrientationPublisher {
  const sendMessage = input !== null && typeof input === "object" && typeof input.pi?.sendMessage === "function"
    ? input.pi.sendMessage.bind(input.pi)
    : undefined;

  async function publish(content: AgentOrientationContent, briefPath: string, context: ExtensionContext): Promise<void> {
    try {
      await writeAtomically(briefPath, content.briefMarkdown);
    } catch {
      // The brief is advisory. Keep the session-start injection useful even if
      // a local filesystem write fails.
    }
    if (hasActiveDigest(context, content.factsDigest)) return;
    if (sendMessage === undefined) return;
    try {
      sendMessage({
        customType: AGENT_ORIENTATION_CUSTOM_TYPE,
        content: content.injectionLines.join("\n"),
        display: false,
        details: { factsDigest: content.factsDigest },
      }, { triggerTurn: false });
    } catch {
      // Pi's send path is itself best-effort for this informational surface.
    }
  }

  return Object.freeze({
    publish,
    async publishUnavailable(unavailable): Promise<void> {
      const content = assembleUnavailableOrientation({
        packageVersion: unavailable.packageVersion,
        briefPath: unavailable.briefPath,
        code: unavailable.code,
        sha256: unavailable.sha256,
      });
      await publish(content, unavailable.briefPath, unavailable.context);
    },
  });
}
