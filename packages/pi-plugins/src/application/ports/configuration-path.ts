import { z } from "zod";
import { CanonicalConfigurationPathSchema } from "../../domain/configured-values.js";
import type { ScopeContext } from "../../domain/state/scope.js";
import type { TrustedProjectRoot } from "./project-root-authority.js";

/**
 * User scope retains its adapter-owned base for compatibility. Project scope
 * must use the opaque capability; a bare path is never accepted there.
 */
export type ConfigurationPathContext = Readonly<{
  scope: ScopeContext;
  trustedBaseDirectory?: string;
  trustedProjectRoot?: TrustedProjectRoot;
}>;

export const ConfigurationPathResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("valid"), canonicalPath: CanonicalConfigurationPathSchema }).strict(),
  z.object({ kind: z.enum(["missing", "wrong-kind", "invalid"]) }).strict(),
]).readonly();
export type ConfigurationPathResult = z.infer<typeof ConfigurationPathResultSchema>;

export interface ConfigurationPathPort {
  normalizeAndInspect(
    input: Readonly<{
      value: string;
      expected: "file" | "directory";
      mustExist: boolean;
      context: ConfigurationPathContext;
    }>,
    signal: AbortSignal,
  ): Promise<ConfigurationPathResult>;
}
