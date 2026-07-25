import type { HookDocumentReader } from "../hook-reader-support.js";
import {
  parseHookDocument,
  readHookDocument,
} from "../hook-reader-support.js";

/** Pure Claude hooks.json reader; command handlers are never executed. */
export const readClaudeHooks: HookDocumentReader = (input, context) => {
  if (context.nativeHost !== "claude") {
    return readHookDocument("readClaudeHooks", input, context, () => {
      throw new Error("Claude hook reader requires a Claude provenance context");
    });
  }
  return readHookDocument("readClaudeHooks", input, context, (value) =>
    parseHookDocument(value, context),
  );
};

export const readClaudeHookDocument = readClaudeHooks;

export type { HookDocumentReader } from "../hook-reader-support.js";
