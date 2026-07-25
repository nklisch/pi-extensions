import { z } from "zod";
import {
  HostConfigDocumentSchema,
  type HostConfigDocument,
} from "./config-state.js";
import {
  InstalledUserStateDocumentSchema,
  type InstalledUserStateDocument,
} from "./installed-state.js";
import {
  ProjectLocalStateDocumentSchema,
  type ProjectLocalStateDocument,
} from "./project-state.js";
import {
  StatePointersDocumentSchema,
  type StatePointersDocument,
} from "./pointers.js";
import {
  TrustStateDocumentSchema,
  type TrustStateDocument,
} from "./trust-state.js";
import {
  PortableProjectDeclarationSchema,
  type PortableProjectDeclaration,
} from "./portable-project-declaration.js";
import {
  StateDocumentKindSchema,
  StateDocumentKindRegistry,
  type StateDocumentKind,
} from "./pointers.js";

export type StateDocumentIsolation =
  | "marketplace-record"
  | "plugin-record"
  | "trust-record"
  | "none";

/**
 * The authoritative routing table for durable state. New document kinds must
 * be added here before they can be decoded or encoded. Each kind carries
 * exactly one current schema; the literal schemaVersion lets a future clean
 * cut-over recognize stale documents, which are reinitialized rather than
 * migrated.
 */
export const StateDocumentRegistry = {
  hostConfig: {
    schema: HostConfigDocumentSchema,
    schemaVersion: 4,
    isolation: "marketplace-record",
  },
  installedUser: {
    schema: InstalledUserStateDocumentSchema,
    schemaVersion: 2,
    isolation: "plugin-record",
  },
  trust: {
    schema: TrustStateDocumentSchema,
    schemaVersion: 1,
    isolation: "trust-record",
  },
  projectLocal: {
    schema: ProjectLocalStateDocumentSchema,
    schemaVersion: 4,
    isolation: "plugin-record",
  },
  portableProject: {
    schema: PortableProjectDeclarationSchema,
    schemaVersion: 1,
    isolation: "none",
  },
  pointers: {
    schema: StatePointersDocumentSchema,
    schemaVersion: 1,
    isolation: "none",
  },
} as const satisfies Record<
  StateDocumentKind,
  Readonly<{
    schema: z.ZodTypeAny;
    schemaVersion: number;
    isolation: StateDocumentIsolation;
  }>
>;

export type RegisteredStateDocument = (typeof StateDocumentRegistry)[StateDocumentKind];

/**
 * The registry schema is the contract source. Inferring these outputs from the
 * registered schemas prevents a new kind from acquiring a second,
 * hand-maintained persistence interface in this module.
 */
export type StateDocumentByKind<K extends StateDocumentKind = StateDocumentKind> = z.infer<
  (typeof StateDocumentRegistry)[K]["schema"]
>;
export type StateDocumentFor<K extends StateDocumentKind> = StateDocumentByKind<K>;

export function getStateDocumentDefinition(
  kind: unknown,
): RegisteredStateDocument {
  const parsed = StateDocumentKindSchema.parse(kind);
  return StateDocumentRegistry[parsed];
}

/** Stable registry order is useful for diagnostics and deterministic tooling. */
export function stateDocumentKinds(): readonly StateDocumentKind[] {
  return Object.keys(StateDocumentKindRegistry) as StateDocumentKind[];
}

export { StateDocumentKindRegistry, StateDocumentKindSchema } from "./pointers.js";

export type {
  HostConfigDocument,
  InstalledUserStateDocument,
  ProjectLocalStateDocument,
  PortableProjectDeclaration,
  StatePointersDocument,
  TrustStateDocument,
  StateDocumentKind,
};
