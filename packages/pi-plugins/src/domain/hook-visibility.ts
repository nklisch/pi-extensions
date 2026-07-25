import { z } from "zod";

/**
 * How model-bound hook context appears in the user's transcript:
 * - `hidden` — never shown (the historical behavior; model still receives it);
 * - `line` — one collapsed transcript line per contribution, expandable to
 *   the exact injected text;
 * - `full` — the exact injected text, always expanded.
 * The preference gates presentation only; delivery to the model is unchanged.
 */
export const HookContextVisibilitySchema = z.enum(["hidden", "line", "full"]);
export type HookContextVisibility = z.infer<typeof HookContextVisibilitySchema>;

export const DefaultHookContextVisibility: HookContextVisibility = "line";
