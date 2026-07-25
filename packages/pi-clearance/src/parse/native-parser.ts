import { requireNativeEngine } from "../native/loader.ts";
import type { ToolShape } from "./shape.ts";

/** Synchronous native parser exposed as a promise for existing replay seams. */
export function analyzeBashCommand(command: string): Promise<ToolShape> {
  return Promise.resolve(requireNativeEngine().parseBash(command));
}
