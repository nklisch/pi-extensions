import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../../src/config/loader.ts";
import { resolveConfigPaths } from "../../src/config/paths.ts";
import { createPackRegistry } from "../../src/packs/registry.ts";
import { buildAutoReviewerStatusView } from "../../src/runtime/auto-reviewer-read-models.ts";

const originalEnv = { ...process.env };
let root: string;
let cwd: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pi-clearance-status-"));
  cwd = path.join(root, "repo");
  await mkdir(cwd, { recursive: true });
  process.env = { ...originalEnv, XDG_CONFIG_HOME: path.join(root, "config") };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function context(): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    modelRegistry: undefined,
    model: undefined,
  } as unknown as ExtensionContext;
}

async function status() {
  const config = await loadConfig({ cwd, isProjectTrusted: true });
  return buildAutoReviewerStatusView({
    ctx: context(),
    policy: {
      config,
      effectivePolicy: { rules: [] },
      registry: createPackRegistry({ resolvedConfig: config }),
      packageRegistration: { requestId: null, packs: [], issues: [] },
      warnings: [],
    },
    ratchet: { active: false, previousActiveTools: [], ratchetToolNames: [] },
  });
}

describe("Clearance status customizations", () => {
  it("is silent for resolved defaults and names categories for custom settings", async () => {
    expect((await status()).customizations).toEqual([]);

    const paths = resolveConfigPaths(cwd);
    await mkdir(path.dirname(paths.globalConfigFile), { recursive: true });
    await writeFile(
      paths.globalConfigFile,
      JSON.stringify({
        version: 1,
        gatedTools: ["edit"],
        reviewer: {
          promptPosture: "reviewer.permissive",
          model: "provider/model",
        },
      }),
      "utf8",
    );

    expect((await status()).customizations).toEqual([
      "posture",
      "model pin",
      "gated tools (1)",
    ]);
  });
});
