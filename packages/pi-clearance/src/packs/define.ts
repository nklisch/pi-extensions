import type { PolicyPack } from "../policy/core.ts";
import { compilePack } from "../policy/core.ts";

/** Compile a shipped JSON-shaped policy pack and fail fast if it drifts. */
export function defineShippedPack(raw: unknown): PolicyPack {
  const compiled = compilePack(raw);
  if (compiled.pack === null) {
    throw new Error(
      `shipped policy pack failed to compile: ${JSON.stringify(compiled.errors)}`,
    );
  }

  return compiled.pack;
}
