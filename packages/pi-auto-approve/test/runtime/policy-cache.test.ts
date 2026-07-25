import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditLogger } from "../../src/audit/logger.ts";
import type { ResolvedConfig } from "../../src/config/loader.ts";
import { resolveConfigPaths } from "../../src/config/paths.ts";
import {
  normalizePackagePackRegistration,
  type PackageRegistrationIssue,
} from "../../src/packs/package-contract.ts";
import type { PackageRegistrationSnapshot } from "../../src/packs/package-registration.ts";
import { createPackRegistry } from "../../src/packs/registry.ts";
import type { EffectivePolicy } from "../../src/policy/core.ts";
import {
  createCachingPolicyResolver,
  type PolicyResolverResult,
} from "../../src/runtime/policy-cache.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedProjectScope,
  defaultResolvedReviewer,
} from "../fixtures/resolved-config.ts";

const ORIGINAL_ENV = { ...process.env };
let tempRoot: string;
let configHome: string;

const audit: AuditLogger = {
  async log() {
    // Tests exercise the resolver seam; audit writes are irrelevant here.
  },
};

beforeEach(async () => {
  tempRoot = await mkdtemp(
    path.join(tmpdir(), "pi-auto-approve-policy-cache-"),
  );
  configHome = path.join(tempRoot, "xdg-config");
  process.env = { ...ORIGINAL_ENV, XDG_CONFIG_HOME: configHome };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("createCachingPolicyResolver", () => {
  it("calls loadAndCompose once per cwd and returns the cached result", async () => {
    const calls: string[] = [];
    const result = okResult("/repo");
    const resolver = createCachingPolicyResolver({
      audit,
      loadAndCompose: async (ctx) => {
        calls.push(ctx.cwd);
        return result;
      },
    });
    const ctx = contextFor("/repo");

    await expect(resolver.resolve(ctx)).resolves.toBe(result);
    await expect(resolver.resolve(ctx)).resolves.toBe(result);

    expect(calls).toEqual(["/repo"]);
  });

  it("resolves different cwd values independently", async () => {
    const calls: string[] = [];
    const resolver = createCachingPolicyResolver({
      audit,
      loadAndCompose: async (ctx) => {
        calls.push(ctx.cwd);
        return okResult(ctx.cwd);
      },
    });

    const first = await resolver.resolve(contextFor("/repo-a"));
    const second = await resolver.resolve(contextFor("/repo-b"));

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(calls).toEqual(["/repo-a", "/repo-b"]);
  });

  it("caches failed resolution results", async () => {
    let calls = 0;
    const failure = { ok: false, reason: "bad config" } as const;
    const resolver = createCachingPolicyResolver({
      audit,
      loadAndCompose: async () => {
        calls += 1;
        return failure;
      },
    });
    const ctx = contextFor("/repo");

    await expect(resolver.resolve(ctx)).resolves.toBe(failure);
    await expect(resolver.resolve(ctx)).resolves.toBe(failure);

    expect(calls).toBe(1);
  });

  it("converts a rejected loadAndCompose promise into a cached failure", async () => {
    let calls = 0;
    const resolver = createCachingPolicyResolver({
      audit,
      loadAndCompose: async () => {
        calls += 1;
        throw new Error("filesystem unavailable");
      },
    });
    const ctx = contextFor("/repo");

    await expect(resolver.resolve(ctx)).resolves.toEqual({
      ok: false,
      reason: "policy resolution failed: filesystem unavailable",
    });
    await expect(resolver.resolve(ctx)).resolves.toEqual({
      ok: false,
      reason: "policy resolution failed: filesystem unavailable",
    });
    expect(calls).toBe(1);
  });

  it("sanitizes malformed registered-tool snapshots instead of throwing", async () => {
    let calls = 0;
    const resolver = createCachingPolicyResolver({
      audit,
      registeredToolNames: () =>
        ["bash", undefined, "", "todo", null] as unknown as readonly string[],
      loadAndCompose: async (ctx) => {
        calls += 1;
        return okResult(ctx.cwd);
      },
    });
    const ctx = contextFor("/repo");

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({ ok: true });
    await expect(resolver.resolve(ctx)).resolves.toMatchObject({ ok: true });
    expect(calls).toBe(1);
  });

  it("invalidates one cwd or the whole cache", async () => {
    const calls: string[] = [];
    const resolver = createCachingPolicyResolver({
      audit,
      loadAndCompose: async (ctx) => {
        calls.push(ctx.cwd);
        return okResult(ctx.cwd);
      },
    });

    await resolver.resolve(contextFor("/repo-a"));
    await resolver.resolve(contextFor("/repo-b"));
    await resolver.resolve(contextFor("/repo-a"));
    resolver.invalidate("/repo-a");
    await resolver.resolve(contextFor("/repo-a"));
    await resolver.resolve(contextFor("/repo-b"));
    resolver.invalidate();
    await resolver.resolve(contextFor("/repo-a"));
    await resolver.resolve(contextFor("/repo-b"));

    expect(calls).toEqual([
      "/repo-a",
      "/repo-b",
      "/repo-a",
      "/repo-a",
      "/repo-b",
    ]);
  });

  it("adds package registrations to the registry without changing effective policy", async () => {
    const snapshot = packageSnapshot({
      requestId: "request-1",
      rawPack: rawPackagePack("pack:registered", "deny-bash", "deny", {
        tool: "bash",
      }),
      issues: [
        {
          severity: "warning",
          code: "fixture-warning",
          packageName: "demo-pkg",
          path: "$.packs[0]",
          message: "fixture package warning",
        },
      ],
    });
    const resolver = createCachingPolicyResolver({
      audit,
      packageRegistration: () => snapshot,
    });

    const result = await resolver.resolve(
      contextFor(path.join(tempRoot, "repo")),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.policy.packageRegistration).toBe(snapshot);
    const packageEntry = result.policy.registry.entries.find(
      (entry) => entry.id === "pack:registered",
    );
    expect(packageEntry).toMatchObject({
      source: { kind: "package", packageName: "demo-pkg" },
      availability: { enabled: false, enabledBy: [] },
    });
    expect(result.policy.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("fixture-warning")]),
    );
    expect(result.policy.effectivePolicy.active).toBeDefined();
    expect(
      result.policy.effectivePolicy.active?.some(
        (rule) => rule.provenance.source === "package",
      ),
    ).toBe(false);
  });

  it("activates globally enabled package packs", async () => {
    const repo = path.join(tempRoot, "repo");
    const paths = resolveConfigPaths(repo);
    await writeJson(paths.globalConfigFile, {
      version: 1,
      packEnablement: { enabledPackagePacks: ["pack:registered"] },
    });
    const snapshot = packageSnapshot({
      requestId: "request-1",
      rawPack: rawPackagePack(
        "pack:registered",
        "allow-package-tool",
        "allow",
        {
          program: "package-tool",
        },
      ),
    });
    const resolver = createCachingPolicyResolver({
      audit,
      packageRegistration: () => snapshot,
    });

    const result = await resolver.resolve(contextFor(repo));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.policy.config.packEnablement.effectivePackagePackIds).toEqual(
      ["pack:registered"],
    );
    const packageEntry = result.policy.registry.entries.find(
      (entry) => entry.id === "pack:registered",
    );
    expect(packageEntry?.availability.enabled).toBe(true);
    expect(packageEntry?.availability.enabledBy).toEqual([
      { kind: "package-config" },
    ]);
    expect(packageRuleIds(result.policy.effectivePolicy)).toEqual([
      "allow-package-tool",
    ]);
  });

  it("activates project-enabled package packs", async () => {
    const repo = path.join(tempRoot, "repo");
    const paths = resolveConfigPaths(repo);
    await writeJson(paths.projectOverlayFile, {
      version: 1,
      packEnablement: { enabledPackagePacks: ["pack:project"] },
    });
    const snapshot = packageSnapshot({
      requestId: "request-1",
      rawPack: rawPackagePack("pack:project", "allow-project-tool", "allow", {
        program: "project-tool",
      }),
    });
    const resolver = createCachingPolicyResolver({
      audit,
      packageRegistration: () => snapshot,
    });

    const result = await resolver.resolve(contextFor(repo));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.policy.config.packEnablement.effectivePackagePackIds).toEqual(
      ["pack:project"],
    );
    expect(packageRuleIds(result.policy.effectivePolicy)).toEqual([
      "allow-project-tool",
    ]);
  });

  it("lets project disabledPackagePacks suppress a globally enabled package", async () => {
    const repo = path.join(tempRoot, "repo");
    const paths = resolveConfigPaths(repo);
    await writeJson(paths.globalConfigFile, {
      version: 1,
      packEnablement: { enabledPackagePacks: ["pack:registered"] },
    });
    await writeJson(paths.projectOverlayFile, {
      version: 1,
      packEnablement: { disabledPackagePacks: ["pack:registered"] },
    });
    const snapshot = packageSnapshot({
      requestId: "request-1",
      rawPack: rawPackagePack(
        "pack:registered",
        "allow-package-tool",
        "allow",
        {
          program: "package-tool",
        },
      ),
    });
    const resolver = createCachingPolicyResolver({
      audit,
      packageRegistration: () => snapshot,
    });

    const result = await resolver.resolve(contextFor(repo));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.policy.config.packEnablement.effectivePackagePackIds).toEqual(
      [],
    );
    const packageEntry = result.policy.registry.entries.find(
      (entry) => entry.id === "pack:registered",
    );
    expect(packageEntry?.availability.enabled).toBe(false);
    expect(packageRuleIds(result.policy.effectivePolicy)).toEqual([]);
  });

  it("warns and skips missing enabled package ids", async () => {
    const repo = path.join(tempRoot, "repo");
    const paths = resolveConfigPaths(repo);
    await writeJson(paths.globalConfigFile, {
      version: 1,
      packEnablement: { enabledPackagePacks: ["pack:missing"] },
    });
    const resolver = createCachingPolicyResolver({
      audit,
      packageRegistration: emptyPackageRegistrationSnapshot,
    });

    const result = await resolver.resolve(contextFor(repo));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.policy.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Enabled package pack "pack:missing"'),
      ]),
    );
    expect(packageRuleIds(result.policy.effectivePolicy)).toEqual([]);
  });

  it("warns and skips ambiguous enabled package ids", async () => {
    const repo = path.join(tempRoot, "repo");
    const paths = resolveConfigPaths(repo);
    await writeJson(paths.globalConfigFile, {
      version: 1,
      packEnablement: { enabledPackagePacks: ["pack:dupe"] },
    });
    const snapshot = packageSnapshotMany({
      requestId: "request-1",
      packages: [
        {
          packageName: "demo-a",
          rawPack: rawPackagePack("pack:dupe", "allow-a", "allow", {
            program: "tool-a",
          }),
        },
        {
          packageName: "demo-b",
          rawPack: rawPackagePack("pack:dupe", "allow-b", "allow", {
            program: "tool-b",
          }),
        },
      ],
    });
    const resolver = createCachingPolicyResolver({
      audit,
      packageRegistration: () => snapshot,
    });

    const result = await resolver.resolve(contextFor(repo));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.policy.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Enabled package pack "pack:dupe" is ambiguous',
        ),
        expect.stringContaining('Duplicate pack id "pack:dupe"'),
      ]),
    );
    const packageEntries = result.policy.registry.entries.filter(
      (entry) => entry.id === "pack:dupe",
    );
    expect(packageEntries).toHaveLength(2);
    expect(packageEntries.every((entry) => !entry.availability.enabled)).toBe(
      true,
    );
    expect(packageRuleIds(result.policy.effectivePolicy)).toEqual([]);
  });

  it("fails closed when an enabled package pack violates the sealed floor", async () => {
    const repo = path.join(tempRoot, "repo");
    const paths = resolveConfigPaths(repo);
    await writeJson(paths.globalConfigFile, {
      version: 1,
      packEnablement: { enabledPackagePacks: ["pack:unsafe"] },
    });
    const snapshot = packageSnapshot({
      requestId: "request-1",
      rawPack: rawPackagePack("pack:unsafe", "allow-sudo", "allow", {
        program: "sudo",
      }),
    });
    const resolver = createCachingPolicyResolver({
      audit,
      packageRegistration: () => snapshot,
    });

    const result = await resolver.resolve(contextFor(repo));

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("allow rule overlaps sealed-floor deny"),
    });
  });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function contextFor(cwd: string): ExtensionContext {
  return {
    cwd,
    isProjectTrusted: () => false,
  } as unknown as ExtensionContext;
}

function okResult(cwd: string): PolicyResolverResult {
  const config = resolvedConfig(cwd);
  return {
    ok: true,
    policy: {
      config,
      effectivePolicy: emptyPolicy(),
      registry: createPackRegistry({ resolvedConfig: config }),
      packageRegistration: emptyPackageRegistrationSnapshot(),
      warnings: [],
    },
  };
}

function emptyPackageRegistrationSnapshot(): PackageRegistrationSnapshot {
  return {
    requestId: null,
    packs: [],
    issues: [],
  };
}

function packageRuleIds(policy: EffectivePolicy): readonly string[] {
  return (policy.active ?? []).flatMap((rule) =>
    rule.provenance.source === "package" ? [rule.id] : [],
  );
}

function packageSnapshot(input: {
  readonly requestId: string;
  readonly rawPack: unknown;
  readonly issues?: readonly PackageRegistrationIssue[];
}): PackageRegistrationSnapshot {
  const normalized = normalizePackagePackRegistration({
    apiVersion: 1,
    requestId: input.requestId,
    package: {
      name: "demo-pkg",
      version: "1.2.3",
      installKind: "npm",
      packagePath: "/repo/node_modules/demo-pkg",
    },
    packs: [{ kind: "data-pack", pack: input.rawPack }],
  });
  if (normalized.packs.length !== 1) {
    throw new Error(
      `package fixture failed to normalize: ${JSON.stringify(normalized.issues)}`,
    );
  }
  return {
    requestId: input.requestId,
    packs: normalized.packs,
    issues: [...normalized.issues, ...(input.issues ?? [])],
  };
}

function packageSnapshotMany(input: {
  readonly requestId: string;
  readonly packages: readonly {
    readonly packageName: string;
    readonly rawPack: unknown;
  }[];
}): PackageRegistrationSnapshot {
  const snapshots = input.packages.map((item) =>
    normalizePackagePackRegistration({
      apiVersion: 1,
      requestId: input.requestId,
      package: {
        name: item.packageName,
        version: "1.2.3",
        installKind: "npm",
        packagePath: `/repo/node_modules/${item.packageName}`,
      },
      packs: [{ kind: "data-pack", pack: item.rawPack }],
    }),
  );
  const packs = snapshots.flatMap((snapshot) => snapshot.packs);
  if (packs.length !== input.packages.length) {
    throw new Error(
      `package fixtures failed to normalize: ${JSON.stringify(
        snapshots.flatMap((snapshot) => snapshot.issues),
      )}`,
    );
  }
  return {
    requestId: input.requestId,
    packs,
    issues: snapshots.flatMap((snapshot) => snapshot.issues),
  };
}

function rawPackagePack(
  packId: string,
  ruleId: string,
  effect: "allow" | "deny" | "review",
  match: unknown,
): unknown {
  return {
    version: 1,
    id: packId,
    rules: [
      {
        id: ruleId,
        effect,
        match,
        reason: `${effect} fixture`,
        provenance: { source: "package" },
      },
    ],
  };
}

function resolvedConfig(cwd: string): ResolvedConfig {
  return {
    version: 1,
    cwd,
    mode: "ask",
    unknownToolPosture: "review",
    projectScope: defaultResolvedProjectScope(),
    packEnablement: defaultResolvedPackEnablement(),
    display: defaultResolvedDisplay(),
    globalPacks: [],
    projectPacks: [],
    repoPacks: [],
    trustedProject: {
      trusted: false,
    },
    reviewer: defaultResolvedReviewer(),
    errors: [],
    warnings: [],
  };
}

function emptyPolicy(): EffectivePolicy {
  return { rules: [] };
}
