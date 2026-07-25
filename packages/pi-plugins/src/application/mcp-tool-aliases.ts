import { z } from "zod";
import { canonicalJson, compareUtf8, hasLoneSurrogate } from "../domain/canonical-json.js";
import { ComponentIdSchema } from "../domain/components.js";
import {
  McpRuntimeServerKeySchemaV1,
  McpSourceIdentitySchemaV1,
  McpToolAliasTemplateSchemaV1,
  type McpToolAliasTemplate,
} from "./ports/mcp-runtime.js";

export const McpToolAliasClaimSchemaV1 = z.object({
  source: McpSourceIdentitySchemaV1,
  serverKey: McpRuntimeServerKeySchemaV1,
  componentId: ComponentIdSchema,
  nativeToolName: z.string().min(1),
  alias: z.string().min(1),
}).strict().readonly();
export type McpToolAliasClaim = z.infer<typeof McpToolAliasClaimSchemaV1>;

export type McpToolAliasResolution = Readonly<{
  exposed: readonly McpToolAliasClaim[];
  omitted: readonly Readonly<{
    claim: McpToolAliasClaim;
    code: "NATIVE_NAME_COLLISION" | "ALIAS_CLAIM_COLLISION" | "UNREPRESENTABLE_ALIAS";
  }>[];
}>;

function claimTuple(claim: McpToolAliasClaim): readonly string[] {
  return [
    canonicalJson(claim.source),
    claim.serverKey,
    claim.componentId,
    claim.nativeToolName,
    claim.alias,
  ];
}

function compareClaimText(left: string, right: string): number {
  if (!hasLoneSurrogate(left) && !hasLoneSurrogate(right)) return compareUtf8(left, right);
  return left < right ? -1 : left > right ? 1 : 0;
}

function claimKey(claim: McpToolAliasClaim): string {
  return JSON.stringify(claimTuple(claim));
}

function compareClaims(left: McpToolAliasClaim, right: McpToolAliasClaim): number {
  const leftTuple = claimTuple(left);
  const rightTuple = claimTuple(right);
  for (let index = 0; index < leftTuple.length; index += 1) {
    const comparison = compareClaimText(leftTuple[index]!, rightTuple[index]!);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function aliasWellFormed(value: string): boolean {
  if (hasLoneSurrogate(value)) return false;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint >= 0x7f && codePoint <= 0x9f) return false;
  }
  return true;
}

/** Exact Claude plugin alias spelling; no segment is rewritten. */
export function formatMcpToolAlias(
  template: McpToolAliasTemplate,
  nativeToolName: string,
): string {
  const valid = McpToolAliasTemplateSchemaV1.parse(template);
  const tool = z.string().min(1).parse(nativeToolName);
  return `mcp__plugin_${valid.pluginName}_${valid.nativeServerKey}__${tool}`;
}

/**
 * Resolve one complete post-discovery snapshot. Native names reserve their
 * exact spelling and every claimant loses a contested alias.
 */
export function resolveMcpToolAliases(input: Readonly<{
  nativeToolNames: readonly string[];
  claims: readonly McpToolAliasClaim[];
  isRepresentable(name: string): boolean;
}>): McpToolAliasResolution {
  if (typeof input.isRepresentable !== "function") {
    throw new TypeError("MCP alias resolution requires a representability predicate");
  }
  const nativeNames = new Set(z.array(z.string().min(1)).readonly().parse(input.nativeToolNames));
  const unique = new Map<string, McpToolAliasClaim>();
  for (const rawClaim of input.claims) {
    const claim = McpToolAliasClaimSchemaV1.parse(rawClaim);
    unique.set(claimKey(claim), claim);
  }
  const claims = [...unique.values()].sort(compareClaims);
  const byAlias = new Map<string, McpToolAliasClaim[]>();
  for (const claim of claims) {
    const group = byAlias.get(claim.alias) ?? [];
    group.push(claim);
    byAlias.set(claim.alias, group);
  }

  const exposed: McpToolAliasClaim[] = [];
  const omitted: Array<Readonly<{
    claim: McpToolAliasClaim;
    code: "NATIVE_NAME_COLLISION" | "ALIAS_CLAIM_COLLISION" | "UNREPRESENTABLE_ALIAS";
  }>> = [];
  for (const claim of claims) {
    let code: (typeof omitted)[number]["code"] | undefined;
    if (!aliasWellFormed(claim.alias) || !input.isRepresentable(claim.alias)) {
      code = "UNREPRESENTABLE_ALIAS";
    } else if (nativeNames.has(claim.alias)) {
      code = "NATIVE_NAME_COLLISION";
    } else if ((byAlias.get(claim.alias)?.length ?? 0) > 1) {
      code = "ALIAS_CLAIM_COLLISION";
    }
    if (code === undefined) exposed.push(claim);
    else omitted.push({ claim, code });
  }
  return { exposed, omitted };
}
