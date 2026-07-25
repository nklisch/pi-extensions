import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/loader.ts";
import { resolveConfigPaths } from "../../src/config/paths.ts";
import {
  applyPackEnablementCommand,
  previewPackEnablementCommand,
  previewPackEnablementCommandReport,
} from "../../src/packs/enablement-command.ts";
import {
  normalizePackagePackRegistration,
  type PackageRegistrationIssue,
} from "../../src/packs/package-contract.ts";
import type { PackageRegistrationSnapshot } from "../../src/packs/package-registration.ts";
import { createPackRegistry } from "../../src/packs/registry.ts";
import type { ResolvedPolicy } from "../../src/runtime/policy-cache.ts";

const ORIGINAL_ENV = { ...process.env };
let tempRoot: string;
let cwd: string;
let configHome: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(
    path.join(tmpdir(), "pi-auto-approve-enable-command-"),
  );
  cwd = path.join(tempRoot, "repo");
  configHome = path.join(tempRoot, "xdg-config");
  process.env = { ...ORIGINAL_ENV, XDG_CONFIG_HOME: configHome };
  await mkdir(cwd, { recursive: true });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("previewPackEnablementCommand", () => {
  it("previews global package enablement with target path, patch, provenance, warnings, and acknowledgements", async () => {
    const snapshot = packageSnapshot({
      requestId: "request-1",
      rawPack: rawPackagePack("pack:demo", "allow-demo", "allow", {
        program: "demo-tool",
      }),
    });
    const resolvedPolicy = await policySnapshot(snapshot);

    const report = previewPackEnablementCommandReport({
      resolvedPolicy,
      action: "enable",
      scope: "global",
      subject: "package",
      packId: "pack:demo",
    });

    expect(report.result.ok).toBe(true);
    if (!report.result.ok) {
      throw new Error(report.result.reason);
    }
    expect(report.current).toEqual({
      enabledInScope: false,
      disabledInScope: false,
      effectivelyEnabledPackage: false,
      disabledConfigPack: false,
    });
    expect(report.candidate?.registryEntry?.source).toMatchObject({
      kind: "package",
      packageName: "demo-pkg",
      packageVersion: "1.2.3",
    });
    expect(report.result.plan.targetPath).toBe(
      resolveConfigPaths(cwd).globalConfigFile,
    );
    expect(report.result.plan.patch).toEqual([
      {
        op: "replace",
        path: "/packEnablement/enabledPackagePacks",
        before: [],
        value: ["pack:demo"],
      },
    ]);
    expect(report.result.plan.warnings).toEqual([
      expect.objectContaining({
        source: "metadata",
        code: "metadata-warning-0",
        requiresAcknowledgement: false,
      }),
    ]);
    expect(report.result.plan.requiredAcknowledgementCodes).toEqual([]);
  });

  it("previews project package enablement in the project overlay", async () => {
    const snapshot = packageSnapshot({
      requestId: "request-1",
      rawPack: rawPackagePack("pack:project", "allow-project", "allow", {
        program: "project-tool",
      }),
    });
    const resolvedPolicy = await policySnapshot(snapshot);

    const result = previewPackEnablementCommand({
      resolvedPolicy,
      action: "enable",
      scope: "project",
      subject: "package",
      packId: "pack:project",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.plan.targetPath).toBe(
      resolveConfigPaths(cwd).projectOverlayFile,
    );
    expect(result.plan.patch).toEqual([
      {
        op: "replace",
        path: "/packEnablement/enabledPackagePacks",
        before: [],
        value: ["pack:project"],
      },
    ]);
  });

  it("reports an already-enabled package enablement as a no-op", async () => {
    const paths = resolveConfigPaths(cwd);
    await writeJson(paths.globalConfigFile, {
      version: 1,
      packEnablement: { enabledPackagePacks: ["pack:demo"] },
    });
    const snapshot = packageSnapshot({
      requestId: "request-1",
      rawPack: rawPackagePack("pack:demo", "allow-demo", "allow", {
        program: "demo-tool",
      }),
    });
    const resolvedPolicy = await policySnapshot(snapshot);

    const report = previewPackEnablementCommandReport({
      resolvedPolicy,
      action: "enable",
      scope: "global",
      subject: "package",
      packId: "pack:demo",
    });

    expect(report.current.enabledInScope).toBe(true);
    expect(report.current.effectivelyEnabledPackage).toBe(true);
    expect(report.result.ok).toBe(true);
    if (!report.result.ok) {
      throw new Error(report.result.reason);
    }
    expect(report.result.plan.patch).toEqual([]);
  });

  it("previews package disablement without requiring a registered candidate", async () => {
    const paths = resolveConfigPaths(cwd);
    await writeJson(paths.globalConfigFile, {
      version: 1,
      packEnablement: { enabledPackagePacks: ["pack:gone"] },
    });
    const resolvedPolicy = await policySnapshot(
      emptyPackageRegistrationSnapshot(),
    );

    const result = previewPackEnablementCommand({
      resolvedPolicy,
      action: "disable",
      scope: "global",
      subject: "package",
      packId: "pack:gone",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.plan.patch).toEqual([
      {
        op: "replace",
        path: "/packEnablement/enabledPackagePacks",
        before: ["pack:gone"],
        value: [],
      },
      {
        op: "replace",
        path: "/packEnablement/disabledPackagePacks",
        before: [],
        value: ["pack:gone"],
      },
    ]);
  });

  it("refuses missing or ambiguous package enablement candidates", async () => {
    const missingPolicy = await policySnapshot(
      emptyPackageRegistrationSnapshot(),
    );
    const missing = previewPackEnablementCommand({
      resolvedPolicy: missingPolicy,
      action: "enable",
      scope: "global",
      subject: "package",
      packId: "pack:missing",
    });
    expect(missing).toMatchObject({
      ok: false,
      reason: 'pack candidate "pack:missing" is not available',
    });

    const ambiguousPolicy = await policySnapshot(
      packageSnapshotMany({
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
      }),
    );
    const ambiguous = previewPackEnablementCommand({
      resolvedPolicy: ambiguousPolicy,
      action: "enable",
      scope: "global",
      subject: "package",
      packId: "pack:dupe",
    });
    expect(ambiguous).toMatchObject({
      ok: false,
      reason: 'pack candidate "pack:dupe" is ambiguous',
    });
  });

  it("refuses unsafe and untrusted candidates as non-writable previews", async () => {
    const unsafePolicy = await policySnapshot(
      packageSnapshot({
        requestId: "request-1",
        rawPack: rawPackagePack("pack:unsafe", "allow-sudo", "allow", {
          program: "sudo",
        }),
      }),
    );
    const unsafe = previewPackEnablementCommand({
      resolvedPolicy: unsafePolicy,
      action: "enable",
      scope: "global",
      subject: "package",
      packId: "pack:unsafe",
    });
    expect(unsafe.ok).toBe(false);
    expect(unsafe.ok ? undefined : unsafe.reason).toContain("blocking issues");
  });
});

describe("applyPackEnablementCommand", () => {
  it("refuses missing confirmation before invoking write dependencies", async () => {
    const snapshot = packageSnapshot({
      requestId: "request-1",
      rawPack: rawPackagePack("pack:demo", "allow-demo", "allow", {
        program: "demo-tool",
      }),
    });
    const resolvedPolicy = await policySnapshot(snapshot);
    const preview = previewPackEnablementCommand({
      resolvedPolicy,
      action: "enable",
      scope: "global",
      subject: "package",
      packId: "pack:demo",
    });
    if (!preview.ok) {
      throw new Error(preview.reason);
    }

    const result = await applyPackEnablementCommand(
      {
        plan: preview.plan,
        acknowledgement: {
          confirmedPlanId: "wrong-plan",
          acknowledgedWarningCodes: [],
        },
      },
      {
        reloadConfig: async () => {
          throw new Error("reload should not run");
        },
        validatePostWrite: async () => {
          throw new Error("validation should not run");
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      wrote: false,
      restored: false,
      cacheInvalidated: false,
    });
  });

  it("applies through the shared writer, invalidates cache, and can return recomposed state", async () => {
    const snapshot = packageSnapshot({
      requestId: "request-1",
      rawPack: rawPackagePack("pack:demo", "allow-demo", "allow", {
        program: "demo-tool",
      }),
    });
    const resolvedPolicy = await policySnapshot(snapshot);
    const preview = previewPackEnablementCommand({
      resolvedPolicy,
      action: "enable",
      scope: "global",
      subject: "package",
      packId: "pack:demo",
    });
    if (!preview.ok) {
      throw new Error(preview.reason);
    }

    let invalidations = 0;
    const result = await applyPackEnablementCommand(
      {
        plan: preview.plan,
        acknowledgement: {
          confirmedPlanId: preview.plan.id,
          acknowledgedWarningCodes: preview.plan.requiredAcknowledgementCodes,
        },
      },
      {
        reloadConfig: () => loadConfig({ cwd }),
        validatePostWrite: async () => ({ ok: true }),
        invalidatePolicyCache: () => {
          invalidations += 1;
        },
        resolvePolicy: async () => policySnapshot(snapshot),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      cacheInvalidated: true,
    });
    expect(invalidations).toBe(1);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(
      result.resolvedPolicy?.config.packEnablement.effectivePackagePackIds,
    ).toEqual(["pack:demo"]);
    await expect(
      readJson(resolveConfigPaths(cwd).globalConfigFile),
    ).resolves.toMatchObject({
      packEnablement: { enabledPackagePacks: ["pack:demo"] },
    });
  });
});

async function policySnapshot(
  packageRegistration: PackageRegistrationSnapshot,
): Promise<ResolvedPolicy> {
  const config = await loadConfig({ cwd });
  const registry = createPackRegistry({
    resolvedConfig: config,
    packagePacks: packageRegistration.packs,
    enabledPackageIds: config.packEnablement.effectivePackagePackIds,
    disabledConfigPackIds: config.packEnablement.disabledConfigPackIds,
  });
  return {
    config,
    effectivePolicy: { floor: [], active: [] },
    registry,
    packageRegistration,
    warnings: [],
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function emptyPackageRegistrationSnapshot(): PackageRegistrationSnapshot {
  return { requestId: null, packs: [], issues: [] };
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
    metadata: {
      warnings: [
        {
          level: "warning",
          message: "fixture package metadata warning",
        },
      ],
    },
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
