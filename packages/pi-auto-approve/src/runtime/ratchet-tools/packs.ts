import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  PACK_SOURCE_KINDS,
  type PackRegistryFilter,
  type PackSourceKind,
} from "../../packs/registry.ts";
import {
  type AutoReviewerPackListView,
  type AutoReviewerPackView,
  listAutoReviewerPacks,
} from "../auto-reviewer-read-models.ts";
import type { ResolvedPolicy } from "../policy-cache.ts";
import type { RatchetToolDefinition } from "../ratchet-mode.ts";
import { resolveRatchetPolicy } from "./analysis.ts";
import { RATCHET_TOOL_IDS } from "./ids.ts";
import { formatRatchetToolError, formatRatchetToolResult } from "./result.ts";
import type { RatchetToolDependencies } from "./types.ts";

const STRICT = { additionalProperties: false } as const;

export const AutoReviewerListPacksParameters = Type.Object(
  {
    source: Type.Optional(
      Type.String({
        description:
          "Optional source filter: shipped, user-global, user-project, trusted-repo, or package.",
      }),
    ),
    enabled: Type.Optional(
      Type.Boolean({ description: "Filter to enabled or disabled packs." }),
    ),
    inBaseline: Type.Optional(
      Type.Boolean({
        description: "Filter to packs in the built-in baseline.",
      }),
    ),
    tag: Type.Optional(
      Type.String({ description: "Optional pack tag filter." }),
    ),
  },
  STRICT,
);

export type PackListEntry = AutoReviewerPackView;
export type AutoReviewerListPacksDetails = AutoReviewerPackListView;

interface ParsedPackFilters {
  readonly filter: PackRegistryFilter;
  readonly warnings: readonly string[];
}

export function createAutoReviewerListPacksTool(
  deps: RatchetToolDependencies,
): RatchetToolDefinition {
  return {
    name: RATCHET_TOOL_IDS.listPacks,
    label: "List Clearance Packs",
    description:
      "List shipped, user, project, and package-contributed policy packs with optional source, enabled, baseline, and tag filters.",
    promptSnippet: "List available and enabled Pi Clearance policy packs.",
    promptGuidelines: [
      "Use clearance_list_packs before proposing pack enablement or policy changes.",
    ],
    parameters: AutoReviewerListPacksParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const policy = await resolveRatchetPolicy(ctx, deps);
        const parsed = parsePackFilters(params);
        const details = buildPackListDetails(policy, parsed);

        return formatRatchetToolResult(
          details,
          formatPackListMarkdown(details, parsed.filter),
        ) as unknown as AgentToolResult<AutoReviewerListPacksDetails>;
      } catch (error: unknown) {
        return formatRatchetToolError(
          RATCHET_TOOL_IDS.listPacks,
          error,
        ) as unknown as AgentToolResult<AutoReviewerListPacksDetails>;
      }
    },
  };
}

function parsePackFilters(params: unknown): ParsedPackFilters {
  const record = asRecord(params);
  const warnings: string[] = [];
  const filter: {
    source?: PackSourceKind;
    enabled?: boolean;
    inBaseline?: boolean;
    tag?: string;
  } = {};

  const source = readString(record, "source");
  if (source !== undefined) {
    if (isPackSourceKind(source)) {
      filter.source = source;
    } else {
      warnings.push(
        `Ignoring invalid source filter "${source}". Expected one of: ${PACK_SOURCE_KINDS.join(", ")}.`,
      );
    }
  }

  const inBaseline = record.inBaseline;
  if (typeof inBaseline === "boolean") {
    filter.inBaseline = inBaseline;
  }

  const enabled = record.enabled;
  if (typeof enabled === "boolean") {
    filter.enabled = enabled;
  }

  const tag = readString(record, "tag");
  if (tag !== undefined) {
    filter.tag = tag;
  }

  return { filter, warnings };
}

function asRecord(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isPackSourceKind(value: string): value is PackSourceKind {
  return (PACK_SOURCE_KINDS as readonly string[]).includes(value);
}

function buildPackListDetails(
  policy: ResolvedPolicy,
  parsed: ParsedPackFilters,
): AutoReviewerListPacksDetails {
  const view = listAutoReviewerPacks(policy, parsed.filter);

  return {
    packs: view.packs,
    warnings: stableUnique([...parsed.warnings, ...view.warnings]),
  };
}

function stableUnique<T>(values: readonly T[]): readonly T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function formatPackListMarkdown(
  details: AutoReviewerListPacksDetails,
  filter: PackRegistryFilter,
): string {
  return [
    "# Clearance packs",
    "",
    `- Packs listed: ${details.packs.length}`,
    `- Filters: ${formatFilterSummary(filter)}`,
    `- Warnings: ${details.warnings.length}`,
  ].join("\n");
}

function formatFilterSummary(filter: PackRegistryFilter): string {
  const parts: string[] = [];
  if (filter.source !== undefined) {
    parts.push(`source=${filter.source}`);
  }
  if (filter.enabled !== undefined) {
    parts.push(`enabled=${filter.enabled}`);
  }
  if (filter.inBaseline !== undefined) {
    parts.push(`baseline=${filter.inBaseline}`);
  }
  if (filter.tag !== undefined) {
    parts.push(`tag=${filter.tag}`);
  }
  return parts.length === 0 ? "none" : parts.join(", ");
}
