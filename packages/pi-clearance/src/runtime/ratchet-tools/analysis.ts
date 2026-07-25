import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  buildCorpusQueryModel,
  type CorpusQueryModel,
} from "../../replay/corpus-query.ts";
import type { ReplayCorpus } from "../../replay/history.ts";
import { readReplayCorpus } from "../../replay/reader.ts";
import type { ResolvedPolicy } from "../policy-cache.ts";
import type { RatchetToolDependencies } from "./types.ts";

export interface BuildRatchetCorpusModelOptions {
  readonly includeFullShape?: boolean;
}

export async function resolveRatchetPolicy(
  ctx: ExtensionContext,
  deps: RatchetToolDependencies,
): Promise<ResolvedPolicy> {
  const result = await deps.policyResolver.resolve(ctx);
  if (!result.ok) {
    throw new Error(`clearance policy resolution failed: ${result.reason}`);
  }

  return result.policy;
}

export function readRatchetReplayCorpus(ctx: ExtensionContext): ReplayCorpus {
  // Ratchet-mode tools must reflect live user evidence, not checked-in fixture
  // corpora. The helper CLI can still opt into saved corpora explicitly; the
  // temporary Pi tools default to session history + audit log only.
  return readReplayCorpus({ ctx, corpusPaths: [] });
}

export async function buildRatchetCorpusModel(
  ctx: ExtensionContext,
  policy: ResolvedPolicy,
  options?: BuildRatchetCorpusModelOptions,
): Promise<CorpusQueryModel> {
  try {
    const corpus = readRatchetReplayCorpus(ctx);
    return await buildCorpusQueryModel(corpus, policy.effectivePolicy, {
      pathFacts: {
        cwd: policy.config.cwd,
        projectScope: policy.config.projectScope,
        ...(policy.config.homeDirectory === undefined
          ? {}
          : { homeDirectory: policy.config.homeDirectory }),
      },
      ...(options?.includeFullShape === undefined
        ? {}
        : { includeFullShape: options.includeFullShape }),
      ...(policy.nativePolicy === undefined
        ? {}
        : { nativePolicy: policy.nativePolicy }),
    });
  } catch (error: unknown) {
    throw new Error(`clearance corpus model failed: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
