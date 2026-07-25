import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNativeInspectionService, NativeInspectionError } from "../../src/application/native-inspection-service.js";
import { deriveInspectionDetailId, deriveInspectionEvidenceSnapshotId } from "../../src/application/native-inspection-identifiers.js";
import { NativeInspectionSummarySchema } from "../../src/application/native-inspection-contract.js";
import { toSafeDisplayField } from "../../src/application/native-inspection-display.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const revision = `sha256:${"11".repeat(32)}` as never;
const registrationId = `marketplace-registration-v1:sha256:${"22".repeat(32)}` as never;
const catalogSnapshot = `marketplace-snapshot-v1:sha256:${"33".repeat(32)}` as never;
const candidateId = `marketplace-candidate-v1:sha256:${"44".repeat(32)}` as never;
const safe = (text: string) => toSafeDisplayField(text, { maxScalars: 256 });

function snapshot(generation = 0) {
  return {
    binding: {
      capturedAt: 1,
      scopes: [{ scope: { kind: "user" }, generation, status: "ready", corruptionCodes: [] }],
      currentProject: { projectKey: `project-v1:sha256:${"55".repeat(32)}`, trust: { kind: "trusted" }, epoch: `sha256:${"66".repeat(32)}` },
      catalogs: [{ scope: { kind: "user" }, registrationId, snapshot: catalogSnapshot, cache: { kind: "ready", validator: { kind: "git-commit", revision: "a".repeat(40) }, etag: { kind: "not-applicable" } } }],
      capability: { status: "ready", digest: `sha256:${"77".repeat(32)}`, capturedBy: "fixture" },
      runtimeEpoch: `sha256:${"88".repeat(32)}`,
      recoveryDigest: `sha256:${"99".repeat(32)}`,
      updateDigest: `sha256:${"aa".repeat(32)}`,
    },
    states: [{ ok: true, snapshot: { scope: { kind: "user" }, generation, corruptions: [], installed: { plugins: [{ plugin: "zeta@market", selectedRevision: revision }], marketplaces: [] }, config: { records: [] }, trust: { records: [] } } }],
    currentProject: { identity: { kind: "path-only", canonicalRoot: "file:///project/", limitation: "identity-changes-with-canonical-root" }, projectKey: `project-v1:sha256:${"55".repeat(32)}`, trust: { kind: "trusted" } },
    runtime: [], recovery: { results: [], deferred: false, processed: 0 },
    startup: { status: "ready", blocked: [], capabilities: { mcp: { status: "unavailable", explanation: "none" }, subagents: { status: "unavailable", explanation: "none" }, piReload: { status: "available", explanation: "ready" }, secrets: { status: "available", explanation: "ready" } } },
  } as never;
}

function setup() {
  let current = snapshot();
  const evidence = { capture: vi.fn(async () => current), validate: vi.fn(async () => "current" as const) };
  const installedSubject = { version: 1 as const, subject: "installed" as const, scope: { kind: "user" as const }, plugin: "zeta@market" as never, selectedRevision: revision };
  const installedSummary = NativeInspectionSummarySchema.parse({
    detailId: deriveInspectionDetailId(installedSubject, sha256), subject: "installed", scope: { kind: "user" }, plugin: "zeta@market",
    name: safe("zeta"), marketplace: safe("market"), revision: { installed: safe("1.0.0"), immutable: revision, resolution: "exact" },
    condition: "ready", freshness: { status: "current", basis: "state" }, diagnosticCounts: { error: 0, warning: 0, info: 0 },
  });
  const installed = { inspect: vi.fn(async () => ({ kind: "found" as const, detail: { summary: installedSummary, diagnostics: [] } as never })) };
  const candidates = { inspect: vi.fn() };
  const catalog = { search: vi.fn(async () => ({
    candidates: [{
      id: candidateId, snapshot: catalogSnapshot, scope: { kind: "user" }, registrationId, plugin: "alpha@market", marketplace: "market", name: "alpha",
      available: { kind: "marketplace-snapshot", marketplaceRevision: "a".repeat(40), snapshot: catalogSnapshot, declaredVersion: "2.0.0" },
    }],
    observations: [],
  })), detail: vi.fn() };
  const adoption = { preview: vi.fn(async () => ({ candidates: [], documents: [{ kind: "missing", document: "claude-known-marketplaces", host: "claude", path: ".claude/plugins/known_marketplaces.json" }], diagnostics: [] })) };
  const service = createNativeInspectionService({
    evidence: evidence as never,
    installed: installed as never,
    candidates: candidates as never,
    catalog: catalog as never,
    adoption: adoption as never,
    clock: { nowEpochMilliseconds: () => 1 } as never,
    sha256,
  });
  return { service, evidence, installed, installedSummary, candidates, catalog, adoption, current: () => current, setGeneration: (value: number) => { current = snapshot(value); } };
}

describe("native inspection service", () => {
  it("sorts unified subjects and paginates with snapshot-bound cursors", async () => {
    const value = setup();
    const first = await value.service.list({ subjects: ["installed", "marketplace-candidate"], scope: "all-current", query: "", limit: 1 }, new AbortController().signal);
    expect(first.items.map((item) => item.subject)).toEqual(["installed"]);
    expect(first.nextCursor).toBeDefined();
    const second = await value.service.list({ subjects: ["installed", "marketplace-candidate"], scope: "all-current", query: "", limit: 1, cursor: first.nextCursor }, new AbortController().signal);
    expect(second.items.map((item) => item.plugin)).toEqual(["alpha@market"]);
    expect(value.candidates.inspect).not.toHaveBeenCalled();
    expect(value.catalog.search).toHaveBeenCalled();
  });

  it("rejects cursor and detail replay after authority changes", async () => {
    const value = setup();
    const page = await value.service.list({ subjects: ["installed", "marketplace-candidate"], scope: "all-current", query: "", limit: 1 }, new AbortController().signal);
    const oldSnapshot = page.snapshotId;
    value.setGeneration(1);
    await expect(value.service.list({ subjects: ["installed", "marketplace-candidate"], scope: "all-current", query: "", limit: 1, cursor: page.nextCursor }, new AbortController().signal)).rejects.toEqual(expect.objectContaining({ code: "CURSOR_STALE" }));
    await expect(value.service.detail({ snapshotId: oldSnapshot, detailId: page.items[0]!.detailId }, new AbortController().signal)).resolves.toEqual({ kind: "stale", action: "retry-read" });
  });

  it("reports a clean host without adoption-missing warnings", async () => {
    const value = setup();
    const report = await value.service.diagnose({ target: { kind: "host" }, includeAdoption: true }, new AbortController().signal);
    expect(report.snapshotId).toBe(deriveInspectionEvidenceSnapshotId(value.current().binding, sha256));
    expect(report.condition).toBe("ready");
    expect(report.diagnostics).toEqual([]);
  });

  it("reports granular quarantines, corrupt publication, and blocked startup without hiding valid state", async () => {
    const value = setup();
    const current = value.current() as any;
    const corruption = {
      document: "installedUser", scope: { kind: "user" }, code: "RECORD_INVALID",
      recordIdentity: "broken@market", location: { kind: "pointer", value: "/plugins/0" },
      summary: "state record was quarantined",
    };
    current.binding.scopes[0] = { ...current.binding.scopes[0], status: "corrupt", corruptionCodes: ["RECORD_INVALID"] };
    current.states[0].snapshot.corruptions = [corruption];
    current.binding.catalogs[0].cache = { kind: "corrupt" };
    current.startup = { ...current.startup, status: "blocked", blocked: [{ plugin: "host-runtime", code: "RUNTIME_RECONSTRUCTION_FAILED", explanation: "fixed" }] };

    const report = await value.service.diagnose({ target: { kind: "host" }, includeAdoption: false }, new AbortController().signal);
    expect(report.condition).toBe("blocked");
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "RECORD_CORRUPT", "HOST_STARTUP_BLOCKED", "CATALOG_CORRUPT",
    ]);
    expect(report.diagnostics[0]?.facts.map((fact) => fact.value.text)).toEqual(["RECORD_INVALID", "/plugins/0", "user", "broken@market"]);
  });

  it("keeps corrupt selected catalog evidence visible even when no candidate can be projected", async () => {
    const value = setup();
    (value.current() as any).binding.catalogs[0].cache = { kind: "corrupt" };
    value.catalog.search.mockResolvedValueOnce({ candidates: [], observations: [{ status: "corrupt", cache: { kind: "corrupt" } }] });
    const page = await value.service.list({ subjects: ["marketplace-candidate"], scope: "all-current", query: "", limit: 50 }, new AbortController().signal);
    expect(page.items).toEqual([]);
    expect(page.condition).toBe("blocked");
  });

  it("isolates candidate catalog search by captured scope and redacts adapter failures", async () => {
    const value = setup();
    const current = value.current() as any;
    const projectKey = `project-v1:sha256:${"ab".repeat(32)}`;
    const projectRegistration = `marketplace-registration-v1:sha256:${"bc".repeat(32)}`;
    const projectCandidate = `marketplace-candidate-v1:sha256:${"cd".repeat(32)}`;
    const projectScope = { kind: "project", projectKey };
    current.binding.scopes.push({ scope: projectScope, generation: 0, status: "ready", corruptionCodes: [] });
    current.binding.catalogs.push({ scope: projectScope, registrationId: projectRegistration, snapshot: catalogSnapshot, cache: { kind: "ready", validator: { kind: "git-commit", revision: "b".repeat(40) }, etag: { kind: "not-applicable" } } });
    current.states.push({ ok: true, snapshot: { scope: { kind: "project", identity: current.currentProject.identity, projectKey }, generation: 0, corruptions: [], project: { plugins: [], marketplaces: [], marketplaceUpdates: [] } } });
    value.catalog.search.mockImplementation(async (request: any) => {
      if (request.scope === "user") throw new Error("adapter failure /home/alice/private credential-value");
      return { candidates: [{
        id: projectCandidate, snapshot: catalogSnapshot, scope: projectScope, registrationId: projectRegistration,
        plugin: "project-plugin@market", marketplace: "market", name: "project-plugin",
        available: { kind: "marketplace-snapshot", marketplaceRevision: "b".repeat(40), snapshot: catalogSnapshot },
      }], observations: [] };
    });

    const page = await value.service.list({ subjects: ["marketplace-candidate"], scope: "all-current", query: "", limit: 50 }, new AbortController().signal);
    expect(page.items.map((item) => item.plugin)).toEqual(["project-plugin@market"]);
    expect(page.observations).toMatchObject([
      { scope: { kind: "user" }, status: "unavailable" },
      { scope: projectScope, status: "ready" },
    ]);
    expect(page.condition).toBe("degraded");
    expect(JSON.stringify(page)).not.toContain("adapter failure");
    expect(JSON.stringify(page)).not.toContain("/home/alice");
    expect(value.catalog.search.mock.calls.map(([request]) => request.scope)).toEqual(["user", "project"]);
  });

  it("filters page observations and health to the requested scope and subjects", async () => {
    const value = setup();
    const current = value.current() as any;
    current.binding.catalogs[0].cache = { kind: "corrupt" };
    current.binding.scopes.push({ scope: { kind: "project", projectKey: `project-v1:sha256:${"ac".repeat(32)}` }, status: "corrupt", corruptionCodes: ["DOCUMENT_INVALID"] });

    const installed = await value.service.list({ subjects: ["installed"], scope: "user", query: "", limit: 50 }, new AbortController().signal);
    expect(installed.condition).toBe("ready");
    expect(installed.observations).toMatchObject([{ scope: { kind: "user" }, status: "ready" }]);
    expect(value.catalog.search).not.toHaveBeenCalled();

    // A readable candidate catalog is not blocked by an unrelated quarantined
    // installed record in the same successfully captured scope.
    current.binding.scopes[0] = { ...current.binding.scopes[0], status: "corrupt", corruptionCodes: ["RECORD_INVALID"] };
    current.binding.catalogs[0].cache = { kind: "ready", validator: { kind: "git-commit", revision: "a".repeat(40) }, etag: { kind: "not-applicable" } };
    const candidates = await value.service.list({ subjects: ["marketplace-candidate"], scope: "user", query: "", limit: 50 }, new AbortController().signal);
    expect(candidates.condition).toBe("ready");
    expect(candidates.observations).toMatchObject([{ scope: { kind: "user" }, status: "ready", corruptionCodes: [] }]);
  });

  it("reports an entirely unreadable requested authority as unavailable", async () => {
    const value = setup();
    (value.current() as any).binding.catalogs[0].cache = { kind: "unavailable" };
    value.catalog.search.mockRejectedValue(new Error("native catalog failure"));
    const page = await value.service.list({ subjects: ["marketplace-candidate"], scope: "user", query: "", limit: 50 }, new AbortController().signal);
    expect(page.items).toEqual([]);
    expect(page.observations).toMatchObject([{ scope: { kind: "user" }, status: "unavailable" }]);
    expect(page.condition).toBe("unavailable");
  });

  it("derives page condition from the complete post-filter result rather than the pagination slice", async () => {
    const value = setup();
    const current = value.current() as any;
    const alphaRevision = `sha256:${"ef".repeat(32)}` as never;
    current.states[0].snapshot.installed.plugins.unshift({ plugin: "alpha@market", selectedRevision: alphaRevision });
    const alphaSubject = { version: 1 as const, subject: "installed" as const, scope: { kind: "user" as const }, plugin: "alpha@market" as never, selectedRevision: alphaRevision };
    const alpha = NativeInspectionSummarySchema.parse({
      ...value.installedSummary,
      detailId: deriveInspectionDetailId(alphaSubject, sha256),
      plugin: "alpha@market",
      name: safe("alpha"),
      revision: { installed: safe("1.0.0"), immutable: alphaRevision, resolution: "exact" },
    });
    const blocked = NativeInspectionSummarySchema.parse({ ...value.installedSummary, condition: "blocked", diagnosticCounts: { error: 1, warning: 0, info: 0 } });
    value.installed.inspect.mockImplementation(async (subject: any) => ({ kind: "found", detail: { summary: subject.plugin === "alpha@market" ? alpha : blocked, diagnostics: [] } } as never));

    const first = await value.service.list({ subjects: ["installed"], scope: "user", query: "", limit: 1 }, new AbortController().signal);
    expect(first.items[0]?.plugin).toBe("alpha@market");
    expect(first.items[0]?.condition).toBe("ready");
    expect(first.condition).toBe("blocked");

    const readyOnly = await value.service.list({ subjects: ["installed"], scope: "user", query: "", conditions: ["ready"], limit: 1 }, new AbortController().signal);
    expect(readyOnly.condition).toBe("ready");
  });

  it("keeps diagnostic owners distinct and chooses missing detail diagnostics by subject kind", async () => {
    const value = setup();
    const current = value.current() as any;
    const projectKey = `project-v1:sha256:${"ab".repeat(32)}`;
    const projectScope = { kind: "project", projectKey };
    current.binding.catalogs[0].cache = { kind: "stale", ageMs: 1, retryAt: 2 };
    current.binding.catalogs.push({ scope: projectScope, registrationId: `marketplace-registration-v1:sha256:${"bc".repeat(32)}`, cache: { kind: "stale", ageMs: 1, retryAt: 2 } });
    current.recovery.results = [
      { kind: "blocked", scope: { kind: "user" }, plugin: "one@market", reference: `pending-transition-v1:sha256:${"01".repeat(32)}`, code: "JOURNAL_MISSING" },
      { kind: "blocked", scope: projectScope, plugin: "two@market", reference: `pending-transition-v1:sha256:${"02".repeat(32)}`, code: "JOURNAL_CORRUPT" },
    ];
    value.adoption.preview.mockResolvedValue({ candidates: [], documents: [
      { kind: "unreadable", document: "claude-known-marketplaces", host: "claude", path: ".claude/plugins/known_marketplaces.json", code: "IO_FAILED" },
      { kind: "unreadable", document: "codex-user-config", host: "codex", path: ".codex/config.toml", code: "INVALID_UTF8" },
    ], diagnostics: [] } as never);
    const report = await value.service.diagnose({ target: { kind: "host" }, includeAdoption: true }, new AbortController().signal);
    expect(report.diagnostics.filter((item) => item.code === "CATALOG_STALE")).toHaveLength(2);
    expect(report.diagnostics.filter((item) => item.code === "RECOVERY_BLOCKED")).toHaveLength(2);
    expect(report.diagnostics.filter((item) => item.code === "ADOPTION_DOCUMENT_UNREADABLE")).toHaveLength(2);
    expect(new Set(report.diagnostics.map((item) => item.id)).size).toBe(report.diagnostics.length);

    const snapshotId = deriveInspectionEvidenceSnapshotId(current.binding, sha256);
    value.installed.inspect.mockResolvedValue({ kind: "missing" } as never);
    const installedReport = await value.service.diagnose({ target: { kind: "detail", snapshotId, detailId: value.installedSummary.detailId }, includeAdoption: false }, new AbortController().signal);
    expect(installedReport.diagnostics).toMatchObject([{ code: "REVISION_UNAVAILABLE", subjectId: value.installedSummary.detailId }]);

    const candidateSubject = { version: 1 as const, subject: "marketplace-candidate" as const, scope: { kind: "user" as const }, plugin: "alpha@market" as never, registrationId, candidateId, catalogSnapshot };
    const candidateDetailId = deriveInspectionDetailId(candidateSubject, sha256);
    value.candidates.inspect.mockResolvedValue({ kind: "missing" });
    const candidateReport = await value.service.diagnose({ target: { kind: "detail", snapshotId, detailId: candidateDetailId }, includeAdoption: false }, new AbortController().signal);
    expect(candidateReport.diagnostics).toMatchObject([{ code: "CANDIDATE_MISSING", subjectId: candidateDetailId }]);
  });

  it("revalidates authority before returning unavailable or found detail outcomes", async () => {
    const value = setup();
    const current = value.current();
    value.evidence.validate.mockResolvedValueOnce("stale");
    await expect(value.service.detail({
      snapshotId: deriveInspectionEvidenceSnapshotId(current.binding, sha256),
      detailId: deriveInspectionDetailId({ version: 1, subject: "installed", scope: { kind: "user" }, plugin: "zeta@market", selectedRevision: revision }, sha256),
    }, new AbortController().signal)).resolves.toEqual({ kind: "stale", action: "retry-read" });
  });

  it("returns invalid-id without probing detail inspectors", async () => {
    const value = setup();
    const result = await value.service.detail({ snapshotId: deriveInspectionEvidenceSnapshotId(value.current().binding, sha256), detailId: "inspection-detail-v1:bad." + "0".repeat(64) as never }, new AbortController().signal);
    expect(result).toEqual({ kind: "invalid-id" });
    expect(value.installed.inspect).not.toHaveBeenCalled();
    expect(value.candidates.inspect).not.toHaveBeenCalled();
  });

  it("serializes stale errors without native detail", () => {
    expect(JSON.stringify(new NativeInspectionError("SNAPSHOT_STALE"))).toBe('{"code":"SNAPSHOT_STALE"}');
  });
});
