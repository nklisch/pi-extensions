import {
  AdoptionDocumentKindRegistry,
  adoptionDocumentHosts,
  type AdoptionCandidate,
  type AdoptionDocumentKind,
  reconcileAdoptionDeclarations,
} from "../domain/adoption.js";
import { DiagnosticSchema, ErrorCodeRegistry, type Diagnostic } from "../domain/error-contract.js";
import { createScopeContext, ScopeContextSchema } from "../domain/state/scope.js";
import {
  ForeignStateFileObservationSchema,
  AdoptionDiscoveryResultSchema,
  AdoptionDocumentStatusSchema,
  AdoptionImportRequestSchema,
  AdoptionImportResultSchema,
  AdoptionPreviewRequestSchema,
  AdoptionPreviewResultSchema,
  AdoptionSelectionRequestSchema,
  MarketplaceRegistrationResultSchema,
  type AdoptionDiscoveryResult,
  type AdoptionImportRequest,
  type AdoptionImportResult,
  type AdoptionPreviewRequest,
  type AdoptionPreviewResult,
  type AdoptionReaderRegistry,
  type ForeignStateFileObservation,
} from "./adoption-contract.js";
import type { z } from "zod";
import type { ForeignStateFilesPort } from "./ports/foreign-state-files.js";
import type { MarketplaceRegistrationPort } from "./ports/marketplace-registration.js";
import type { Sha256 } from "../domain/source.js";
import { PortableMarketplaceSourceSchema } from "../domain/state/portable-project-declaration.js";
import { deriveMarketplaceSourceIdentity } from "../domain/update-policy.js";
import type {
  MarketplaceAddRequest,
  MarketplaceAddResult,
  MarketplaceRegistrationListRequest,
  MarketplaceRegistrationPage,
} from "./marketplace-management-contract.js";

const DOCUMENTS = Object.values(AdoptionDocumentKindRegistry);

function throwIfAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function adapterDiagnostic(message: string, details?: Record<string, string>): Diagnostic {
  return DiagnosticSchema.parse({
    code: ErrorCodeRegistry.adapterFailed,
    severity: "error",
    operation: "discoverAdoption",
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function unreadableDiagnostic(observation: Extract<ForeignStateFileObservation, { kind: "unreadable" | "changed-during-read" }>): Diagnostic {
  return adapterDiagnostic("Foreign-state document could not be read", {
    document: observation.document,
    reason: observation.kind === "unreadable" ? observation.code : "CHANGED_DURING_READ",
  });
}

function statusFromObservation(observation: ForeignStateFileObservation) {
  switch (observation.kind) {
    case "missing": return AdoptionDocumentStatusSchema.parse(observation);
    case "present": return AdoptionDocumentStatusSchema.parse({ kind: observation.kind, document: observation.document, host: observation.host, path: observation.path });
    case "unreadable":
    case "changed-during-read": return AdoptionDocumentStatusSchema.parse(observation);
  }
}

function validateObservation(value: unknown): ForeignStateFileObservation | undefined {
  const parsed = ForeignStateFileObservationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function expectedDocumentKinds(): readonly AdoptionDocumentKind[] {
  return DOCUMENTS.map((entry) => entry.tag);
}

function candidateIndex(candidates: readonly AdoptionCandidate[]): Map<string, AdoptionCandidate> {
  return new Map(candidates.map((candidate) => [candidate.id, candidate]));
}

function documentFromPath(host: "claude" | "codex", path: string): AdoptionDocumentKind {
  if (host === "codex") return "codex-user-config";
  return path.endsWith("plugins/known_marketplaces.json")
    ? "claude-known-marketplaces"
    : "claude-user-settings";
}

function adoptionOrigin(candidate: AdoptionCandidate) {
  const documents = candidate.source.provenance.map((claim) => ({
    host: claim.location.host,
    document: documentFromPath(claim.location.host, claim.location.path),
    ...(claim.location.pointer === undefined ? {} : { pointer: claim.location.pointer }),
  }));
  const unique = documents.filter((candidateDocument, index) => documents.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(candidateDocument)) === index)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { kind: "adoption" as const, candidateId: candidate.id, documents: unique as [typeof unique[number], ...typeof unique] };
}

export type MarketplaceAdoptionRegistryPort = Readonly<{
  add(request: MarketplaceAddRequest, signal: AbortSignal): Promise<MarketplaceAddResult>;
  list(request: MarketplaceRegistrationListRequest, signal: AbortSignal): Promise<MarketplaceRegistrationPage>;
}>;

export interface AdoptionService {
  preview(request: AdoptionPreviewRequest, signal: AbortSignal): Promise<AdoptionPreviewResult>;
  import(request: AdoptionImportRequest, signal: AbortSignal): Promise<AdoptionImportResult>;
  /** Compatibility aliases retained for existing integrations during adoption API migration. */
  discover(signal: AbortSignal): Promise<AdoptionDiscoveryResult>;
  adopt(request: z.input<typeof AdoptionSelectionRequestSchema>, signal: AbortSignal): Promise<AdoptionImportResult>;
}

export type AdoptionServiceDependencies = Readonly<{
  files: ForeignStateFilesPort;
  readers: AdoptionReaderRegistry;
  registrations: MarketplaceRegistrationPort;
  registry?: MarketplaceAdoptionRegistryPort;
  sha256: Sha256;
}>;

export function createAdoptionService(
  dependencies: AdoptionServiceDependencies,
): AdoptionService {
  if (typeof dependencies.sha256 !== "function") throw new TypeError("adoption service requires SHA-256");

  async function discover(signal: AbortSignal): Promise<AdoptionDiscoveryResult> {
    throwIfAborted(signal);
    const rawObservations = await dependencies.files.readAll(signal);
    throwIfAborted(signal);
    const observations = new Map<AdoptionDocumentKind, ForeignStateFileObservation>();
    const diagnostics: Diagnostic[] = [];
    for (const raw of rawObservations) {
      const observation = validateObservation(raw);
      if (observation === undefined) {
        diagnostics.push(adapterDiagnostic("Foreign-state adapter returned an invalid observation"));
        continue;
      }
      const expectedHost = adoptionDocumentHosts[observation.document];
      if (expectedHost !== observation.host) {
        diagnostics.push(adapterDiagnostic("Foreign-state adapter returned a mismatched host", { document: observation.document }));
        continue;
      }
      if (observations.has(observation.document)) {
        diagnostics.push(adapterDiagnostic("Foreign-state adapter returned a duplicate document", { document: observation.document }));
        continue;
      }
      observations.set(observation.document, observation);
    }

    const declarations = [] as import("../domain/adoption.js").AdoptionDeclaration[];
    const statuses = [] as import("./adoption-contract.js").AdoptionDocumentStatus[];
    for (const document of expectedDocumentKinds()) {
      const observation = observations.get(document);
      if (observation === undefined) {
        statuses.push(AdoptionDocumentStatusSchema.parse({ kind: "unreadable", document, host: adoptionDocumentHosts[document], path: "<unreported>", code: "IO_FAILED" }));
        diagnostics.push(adapterDiagnostic("Foreign-state adapter omitted a fixed document", { document }));
        continue;
      }
      statuses.push(statusFromObservation(observation));
      if (observation.kind === "unreadable" || observation.kind === "changed-during-read") {
        diagnostics.push(unreadableDiagnostic(observation));
        continue;
      }
      if (observation.kind === "missing") continue;
      const reader = dependencies.readers[observation.document];
      if (reader === undefined) {
        diagnostics.push(adapterDiagnostic("No reader is registered for a foreign-state document", { document: observation.document }));
        continue;
      }
      try {
        const result = reader(observation.source, { path: observation.path });
        declarations.push(...result.items);
        diagnostics.push(...result.diagnostics);
      } catch {
        diagnostics.push(adapterDiagnostic("Foreign-state reader failed safely", { document: observation.document }));
      }
    }
    const reconciled = reconcileAdoptionDeclarations(declarations, dependencies.sha256);
    diagnostics.push(...reconciled.diagnostics);
    return AdoptionDiscoveryResultSchema.parse({ candidates: reconciled.items, documents: statuses, diagnostics });
  }

  async function preview(request: AdoptionPreviewRequest, signal: AbortSignal): Promise<AdoptionPreviewResult> {
    const parsed = AdoptionPreviewRequestSchema.parse(request);
    const discovery = await discover(signal);
    const registrations = dependencies.registry === undefined
      ? []
      : (await dependencies.registry.list({ scope: parsed.compareScope, limit: 100 }, signal)).registrations;
    const candidates = discovery.candidates.map((candidate) => {
      const sourceIdentity = deriveMarketplaceSourceIdentity(candidate.source.value, dependencies.sha256);
      const matches = registrations.filter((registration) => registration.sourceIdentity === sourceIdentity);
      return {
        candidate,
        comparison: matches.length === 0
          ? { kind: "not-registered" as const }
          : {
              kind: "already-registered" as const,
              registrations: matches.map((registration) => registration.id),
              scopes: matches.map((registration) => registration.scope),
            },
      };
    });
    return AdoptionPreviewResultSchema.parse({ candidates, documents: discovery.documents, diagnostics: discovery.diagnostics });
  }

  async function importCandidates(request: AdoptionImportRequest, signal: AbortSignal): Promise<AdoptionImportResult> {
    const parsed = AdoptionImportRequestSchema.parse(request);
    const ids = [...parsed.candidateIds].sort();
    if (signal.aborted) {
      return AdoptionImportResultSchema.parse({
        outcomes: ids.map((candidateId) => ({ candidateId, outcome: { kind: "cancelled-before-start" as const } })),
        diagnostics: [],
      });
    }
    let discovery: AdoptionDiscoveryResult;
    try {
      discovery = await discover(signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      return AdoptionImportResultSchema.parse({
        outcomes: ids.map((candidateId) => ({ candidateId, outcome: { kind: "cancelled-before-start" as const } })),
        diagnostics: [],
      });
    }
    const candidates = candidateIndex(discovery.candidates);
    const outcomes: Array<AdoptionImportResult["outcomes"][number]> = [];
    for (const [index, candidateId] of ids.entries()) {
      if (signal.aborted) {
        for (const remaining of ids.slice(index)) outcomes.push({ candidateId: remaining, outcome: { kind: "cancelled-before-start" } });
        break;
      }
      const candidate = candidates.get(candidateId);
      if (candidate === undefined) {
        outcomes.push({ candidateId, outcome: { kind: "candidate-unavailable" } });
        continue;
      }
      if (parsed.scope === "project" && !PortableMarketplaceSourceSchema.safeParse(candidate.source.value).success) {
        outcomes.push({ candidateId, outcome: { kind: "not-portable" } });
        continue;
      }
      if (dependencies.registry === undefined) {
        outcomes.push({ candidateId, outcome: { kind: "rejected", code: "ADAPTER_FAILED" } });
        continue;
      }
      try {
        const result = await dependencies.registry.add({ source: candidate.source.value, scope: parsed.scope, origin: adoptionOrigin(candidate) }, signal);
        outcomes.push({ candidateId, outcome: result });
      } catch (error) {
        if (signal.aborted || error instanceof DOMException && error.name === "AbortError") {
          outcomes.push({ candidateId, outcome: { kind: "cancelled-before-start" } });
          for (const remaining of ids.slice(index + 1)) outcomes.push({ candidateId: remaining, outcome: { kind: "cancelled-before-start" } });
          break;
        }
        outcomes.push({ candidateId, outcome: { kind: "rejected", code: "ADAPTER_FAILED" } });
      }
    }
    return AdoptionImportResultSchema.parse({ outcomes, diagnostics: discovery.diagnostics });
  }

  async function adopt(request: z.input<typeof AdoptionSelectionRequestSchema>, signal: AbortSignal): Promise<AdoptionImportResult> {
    throwIfAborted(signal);
    const parsedRequest = AdoptionSelectionRequestSchema.parse(request);
    const scope = createScopeContext(ScopeContextSchema.parse(parsedRequest.scope), dependencies.sha256);
    const discovery = await discover(signal);
    const candidates = candidateIndex(discovery.candidates);
    const outcomes: Array<AdoptionImportResult["outcomes"][number]> = [];
    for (const candidateId of [...parsedRequest.candidateIds].sort()) {
      throwIfAborted(signal);
      const candidate = candidates.get(candidateId);
      if (candidate === undefined) {
        outcomes.push({ candidateId, outcome: { kind: "candidate-unavailable" } });
        continue;
      }
      if (scope.kind === "project" && !PortableMarketplaceSourceSchema.safeParse(candidate.source.value).success) {
        outcomes.push({ candidateId, outcome: { kind: "not-portable" } });
        continue;
      }
      try {
        const result = MarketplaceRegistrationResultSchema.safeParse(await dependencies.registrations.register({ source: candidate.source.value, scope, origin: "adoption" }, signal));
        throwIfAborted(signal);
        outcomes.push({ candidateId, outcome: result.success ? result.data : { kind: "rejected", code: "ADAPTER_FAILED" } });
      } catch (error) {
        if (signal.aborted || error instanceof Error && error.name === "AbortError") throw error;
        outcomes.push({ candidateId, outcome: { kind: "rejected", code: "ADAPTER_FAILED" } });
      }
    }
    return AdoptionImportResultSchema.parse({ outcomes, diagnostics: discovery.diagnostics });
  }

  return Object.freeze({ discover, preview, import: importCandidates, adopt });
}
