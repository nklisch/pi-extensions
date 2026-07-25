import { z } from "zod";

/**
 * User-configurable order in which dual-host (Claude + Codex) declarations
 * win reconciliation conflicts. The tuple must name each host exactly once;
 * index 0 is the canonical (winning) host. Precedence only affects NEW
 * inspections — stored normalized plugins are never rewritten when the
 * preference changes.
 */
export const HostPrecedenceSchema = z
  .tuple([z.enum(["claude", "codex"]), z.enum(["claude", "codex"])])
  .readonly()
  .refine((value) => new Set(value).size === 2, {
    message: "host precedence must name each host exactly once",
  });
export type HostPrecedence = z.infer<typeof HostPrecedenceSchema>;

/** Canonical default: Claude declarations win over Codex declarations. */
export const DEFAULT_HOST_PRECEDENCE: HostPrecedence = HostPrecedenceSchema.parse(["claude", "codex"]);

/** Rank of a host inside one precedence ordering; lower wins. */
export function hostRank(precedence: HostPrecedence, host: "claude" | "codex"): number {
  return precedence.indexOf(host);
}
