import {
  MarketplaceRegistrationRecordSchema,
  parseMarketplaceUpdateRecord,
  type MarketplaceRegistrationRecord,
  type MarketplaceUpdateRecord,
} from "../domain/update-policy.js";
import {
  MarketplaceSnapshotRecordSchema,
  type MarketplaceSnapshotRecord,
} from "../domain/state/installed-state.js";
import { serializeMarketplaceSource, type Sha256 } from "../domain/source.js";
import {
  parseStateMutation,
  type GenerationSnapshot,
  type StateMutation,
} from "./state-contract.js";

export function marketplaceUpdateRecords(
  snapshot: GenerationSnapshot,
): readonly MarketplaceRegistrationRecord[] {
  const records = "config" in snapshot
    ? snapshot.config.records
    : snapshot.project.marketplaceUpdates;
  return records.map((record: unknown) => parseMarketplaceUpdateRecord(record));
}

export function marketplaceSnapshots(snapshot: GenerationSnapshot): readonly MarketplaceSnapshotRecord[] {
  const records = "config" in snapshot
    ? ("installed" in snapshot ? snapshot.installed.marketplaces : [])
    : snapshot.project.marketplaces;
  return records.map((record) => MarketplaceSnapshotRecordSchema.parse(record));
}

function verifyRegistrationSnapshotPairs(
  records: readonly MarketplaceRegistrationRecord[],
  snapshots: readonly MarketplaceSnapshotRecord[],
  allowUnmaterialized: boolean,
): void {
  const snapshotNames = new Set(snapshots.map((snapshot) => snapshot.marketplace));
  const names = new Set<string>();
  const sources = new Set<string>();
  for (const record of records) {
    if (names.has(record.marketplace)) throw new Error("duplicate marketplace registration name");
    names.add(record.marketplace);
    const source = serializeMarketplaceSource(record.source);
    if (sources.has(source)) throw new Error("duplicate marketplace registration source");
    sources.add(source);
    if (!allowUnmaterialized && !snapshotNames.has(record.marketplace) && record.origin.kind !== "legacy") {
      throw new Error("marketplace registration requires a selected snapshot");
    }
  }
}

/**
 * Replace the registration registry and selected snapshots in one authoritative
 * generation. The content store remains immutable; only this mutation selects
 * bytes for browse and refresh authority.
 */
export function createMarketplaceRegistrationSnapshotMutation(
  snapshot: GenerationSnapshot,
  records: readonly MarketplaceRegistrationRecord[],
  snapshots: readonly MarketplaceSnapshotRecord[],
  sha256: Sha256,
  options: Readonly<{ allowUnmaterialized?: boolean }> = {},
): StateMutation {
  const parsedRecords = records.map((record) => MarketplaceRegistrationRecordSchema.parse(record));
  const parsedSnapshots = snapshots.map((record) => MarketplaceSnapshotRecordSchema.parse(record));
  verifyRegistrationSnapshotPairs(parsedRecords, parsedSnapshots, options.allowUnmaterialized === true);
  if ("config" in snapshot) {
    const config = {
      ...snapshot.config,
      schemaVersion: 4 as const,
      generation: snapshot.generation,
      records: parsedRecords,
    };
    const installed = {
      ...snapshot.installed,
      generation: snapshot.generation,
      marketplaces: parsedSnapshots,
    };
    return parseStateMutation({
      scope: snapshot.scope,
      expectedGeneration: snapshot.generation,
      replace: { config, installed },
    }, sha256);
  }
  const project = {
    ...snapshot.project,
    schemaVersion: 4 as const,
    generation: snapshot.generation,
    marketplaceUpdates: parsedRecords,
    marketplaces: parsedSnapshots,
  };
  return parseStateMutation({
    scope: snapshot.scope,
    expectedGeneration: snapshot.generation,
    replace: { project },
  }, sha256);
}

/** Policy-only updates intentionally retain the already-selected snapshot. */
export function createMarketplaceUpdateRecordsMutation(
  snapshot: GenerationSnapshot,
  records: readonly MarketplaceUpdateRecord[],
  sha256: Sha256,
): StateMutation {
  const parsedRecords = records.map((record) => MarketplaceRegistrationRecordSchema.parse(record));
  if ("config" in snapshot) {
    return parseStateMutation({
      scope: snapshot.scope,
      expectedGeneration: snapshot.generation,
      replace: {
        config: {
          ...snapshot.config,
          schemaVersion: 4 as const,
          generation: snapshot.generation,
          records: parsedRecords,
        },
      },
    }, sha256);
  }
  return parseStateMutation({
    scope: snapshot.scope,
    expectedGeneration: snapshot.generation,
    replace: {
      project: {
        ...snapshot.project,
        schemaVersion: 4 as const,
        generation: snapshot.generation,
        marketplaceUpdates: parsedRecords,
      },
    },
  }, sha256);
}
