import { describe, expect, it } from "vitest";

import {
  type ConfigEventEntry,
  createArrayAuditSink,
  createAuditLogger,
  type TrustEventEntry,
} from "../../src/audit/log.ts";
import type { ConfigError, ResolvedConfig } from "../../src/config/loader.ts";
import type { RawPolicyPack } from "../../src/config/schema.ts";
import { sealedFloor } from "../../src/packs/floor.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import { composeEffectivePolicy } from "../../src/policy/composer.ts";
import type { DecisionEffect } from "../../src/policy/core.ts";
import { compilePack, decide } from "../../src/policy/core.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedProjectScope,
  defaultResolvedReviewer,
} from "../fixtures/resolved-config.ts";

function rawPack(
  id: string,
  ruleId: string,
  effect: DecisionEffect,
  program: string,
  source: RawPolicyPack["rules"][number]["provenance"]["source"],
): RawPolicyPack {
  return {
    version: 1,
    id,
    rules: [
      {
        id: ruleId,
        effect,
        match: { program },
        reason: `${effect} ${program}`,
        provenance: { source },
      },
    ],
  };
}

function resolvedConfig(
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  const trusted = overrides.trustedProject?.trusted ?? false;

  return {
    version: 1,
    cwd: "/repo",
    mode: "ask",
    unknownToolPosture: "review",
    projectScope: defaultResolvedProjectScope(),
    packEnablement: defaultResolvedPackEnablement(),
    display: defaultResolvedDisplay(),
    globalPacks: [],
    projectPacks: [],
    repoPacks: [],
    trustedProject: {
      trusted,
      ...overrides.trustedProject,
    },
    reviewer: defaultResolvedReviewer(),
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function compileFixturePack(raw: RawPolicyPack) {
  const result = compilePack(raw);
  if (result.pack === null) {
    throw new Error(
      `fixture pack failed to compile: ${JSON.stringify(result.errors)}`,
    );
  }
  return result.pack;
}

function composerHarness() {
  const sink = createArrayAuditSink();
  const audit = createAuditLogger({ sink });
  return { audit, sink };
}

function eventNames(entries: readonly { readonly entryType: string }[]) {
  return entries.map((entry) =>
    entry.entryType === "trust.event" || entry.entryType === "config.event"
      ? (entry as TrustEventEntry | ConfigEventEntry).event
      : entry.entryType,
  );
}

async function bash(command: string) {
  const shape = await analyzeBashCommand(command);
  expect(shape.kind).toBe("bash");
  return shape;
}

const configError: ConfigError = {
  phase: "schema",
  path: "/repo/.pi-auto-approve.json",
  message: "invalid config",
};

describe("composeEffectivePolicy", () => {
  it("composes a fresh-install config into the default posture and logs audit events", async () => {
    const { audit, sink } = composerHarness();

    const result = await composeEffectivePolicy(resolvedConfig(), { audit });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected composition success");
    }

    expect(result.warnings).toEqual([]);
    expect(
      decide(await bash("git status"), result.effectivePolicy),
    ).toMatchObject({
      effect: "allow",
    });
    expect(eventNames(sink.entries)).toEqual([
      "project-untrusted",
      "mode-selected",
      "config-loaded",
    ]);
  });

  it("returns the fallback and logs config-load-failed when resolved config has errors", async () => {
    const { audit, sink } = composerHarness();

    const result = await composeEffectivePolicy(
      resolvedConfig({
        errors: [configError],
        trustedProject: {
          trusted: true,
        },
      }),
      { audit },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected composition failure");
    }

    expect(result.effectivePolicy).toEqual({
      floor: sealedFloor.rules,
      active: [],
      rules: [],
    });
    expect(result.errors).toEqual([
      "[schema][/repo/.pi-auto-approve.json] invalid config",
    ]);
    expect(eventNames(sink.entries)).toEqual([
      "project-trusted",
      "mode-selected",
      "config-load-failed",
    ]);
    expect(sink.entries[2]).toMatchObject({ errors: result.errors });
  });

  it("fails closed when a user-owned allow overlaps the sealed floor", async () => {
    const { audit, sink } = composerHarness();

    const result = await composeEffectivePolicy(
      resolvedConfig({
        globalPacks: [
          rawPack(
            "pack:user-global",
            "allow-sudo",
            "allow",
            "sudo",
            "user-global",
          ),
        ],
      }),
      { audit },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected composition failure");
    }

    expect(result.effectivePolicy).toEqual({
      floor: sealedFloor.rules,
      active: [],
      rules: [],
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("allow rule overlaps sealed-floor deny"),
      ]),
    );
    expect(eventNames(sink.entries)).toEqual([
      "project-untrusted",
      "mode-selected",
      "config-load-failed",
    ]);
  });

  it("drops untrusted repository allow rules before loader overlap validation", async () => {
    const { audit, sink } = composerHarness();

    const result = await composeEffectivePolicy(
      resolvedConfig({
        repoPacks: [
          rawPack(
            "pack:repo",
            "allow-sudo-from-repo",
            "allow",
            "sudo",
            "trusted-repo",
          ),
        ],
      }),
      { audit },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected composition success");
    }

    expect(result.warnings).toEqual([
      "Repository allow rule `allow-sudo-from-repo` dropped because the project is not trusted.",
    ]);
    expect(decide(await bash("sudo ls"), result.effectivePolicy)).toMatchObject(
      {
        effect: "deny",
      },
    );
    expect(eventNames(sink.entries)).toEqual([
      "project-untrusted",
      "mode-selected",
      "config-loaded",
    ]);
  });

  it("fails closed when a trusted repository allow overlaps the sealed floor", async () => {
    const { audit } = composerHarness();

    const result = await composeEffectivePolicy(
      resolvedConfig({
        trustedProject: {
          trusted: true,
        },
        repoPacks: [
          rawPack(
            "pack:repo",
            "allow-sudo-from-trusted-repo",
            "allow",
            "sudo",
            "trusted-repo",
          ),
        ],
      }),
      { audit },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected composition failure");
    }

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("allow rule overlaps sealed-floor deny"),
      ]),
    );
  });

  it("omits disabled config-owned packs from the active policy", async () => {
    const { audit } = composerHarness();

    const result = await composeEffectivePolicy(
      resolvedConfig({
        packEnablement: {
          ...defaultResolvedPackEnablement(),
          disabledConfigPackIds: ["pack:disabled"],
        },
        globalPacks: [
          rawPack(
            "pack:disabled",
            "allow-disabled-tool",
            "allow",
            "disabled-tool",
            "user-global",
          ),
        ],
      }),
      { audit },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected composition success");
    }

    expect(
      decide(await bash("disabled-tool"), result.effectivePolicy),
    ).toMatchObject({
      effect: "review",
      provenance: { source: "default" },
    });
  });

  it("adds explicitly enabled package packs with package provenance", async () => {
    const { audit } = composerHarness();
    const packagePack = compileFixturePack(
      rawPack(
        "pack:package",
        "allow-package-tool",
        "allow",
        "package-tool",
        "package",
      ),
    );

    const result = await composeEffectivePolicy(resolvedConfig(), {
      audit,
      enabledPackagePacks: [packagePack],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected composition success");
    }

    expect(
      decide(await bash("package-tool"), result.effectivePolicy),
    ).toMatchObject({
      effect: "allow",
      provenance: {
        source: "package",
        packId: "pack:package",
        ruleId: "allow-package-tool",
      },
    });
  });
});
