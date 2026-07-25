import type { HookDocumentReader } from "../hook-reader-support.js";
import {
  parseHookDocument,
  readHookDocument,
} from "../hook-reader-support.js";

/** Pure Codex hooks.json reader; command handlers are never executed. */
export const readCodexHooks: HookDocumentReader = (input, context) => {
  if (context.nativeHost !== "codex") {
    return readHookDocument("readCodexHooks", input, context, () => {
      throw new Error("Codex hook reader requires a Codex provenance context");
    });
  }
  return readHookDocument("readCodexHooks", input, context, (value) =>
    parseHookDocument(value, context),
  );
};

export const readCodexHookDocument = readCodexHooks;

export type { HookDocumentReader } from "../hook-reader-support.js";
