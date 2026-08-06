import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  emptyConfigText,
  repairExistingConfigFiles,
  serializeSparseConfig,
} from "../../src/config/persistence.ts";
import {
  GlobalConfigSchema,
  normalizeConfig,
  ProjectOverlaySchema,
} from "../../src/config/schema.ts";

function normalizedGlobal(raw: unknown) {
  const result = normalizeConfig(GlobalConfigSchema, raw);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.value;
}

function normalizedProject(raw: unknown) {
  const result = normalizeConfig(ProjectOverlaySchema, raw);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.value;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("sparse config serialization", () => {
  it("recursively removes defaults while preserving nested choices, arrays, and policy packs", () => {
    const config = normalizedGlobal({
      version: 1,
      mode: "auto",
      gatedTools: ["pi.read"],
      packs: [
        {
          version: 1,
          id: "user.policy",
          rules: [
            {
              id: "allow-node",
              effect: "allow",
              match: { program: "node" },
              reason: "fixture policy",
            },
          ],
        },
      ],
      reviewer: {
        promptAppends: [],
        promptOverride: null,
        tokenBudget: { limit: 4096 },
        recentContext: { conversationTurns: 8 },
      },
      display: { reviewNote: { accent: false } },
    });

    expect(serializeSparseConfig("global", config)).toEqual({
      version: 1,
      display: { reviewNote: { accent: false } },
      gatedTools: ["pi.read"],
      mode: "auto",
      packs: [
        {
          version: 1,
          id: "user.policy",
          rules: [
            {
              id: "allow-node",
              effect: "allow",
              match: { program: "node" },
              reason: "fixture policy",
              provenance: { source: "user-global" },
            },
          ],
        },
      ],
      reviewer: {
        recentContext: { conversationTurns: 8 },
        tokenBudget: { limit: 4096 },
      },
    });
  });

  it("keeps non-default project descendants and omits empty default scaffolding", () => {
    const config = normalizedProject({
      version: 1,
      projectScope: {
        roots: ["packages"],
        safeHomeUseDefaults: false,
        agentSupportDirectories: [],
      },
      promptAppends: ["Prefer the project test command."],
    });

    expect(serializeSparseConfig("project", config)).toEqual({
      version: 1,
      projectScope: {
        roots: ["packages"],
        safeHomeUseDefaults: false,
      },
      promptAppends: ["Prefer the project test command."],
    });
  });

  it("serializes a fully default config as only its version", () => {
    expect(
      serializeSparseConfig("global", normalizedGlobal({ version: 1 })),
    ).toEqual({
      version: 1,
    });
    expect(
      serializeSparseConfig("project", normalizedProject({ version: 1 })),
    ).toEqual({
      version: 1,
    });
  });
});

describe("existing config repair", () => {
  it("does not create an absent config root or project overlay", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "pi-clearance-repair-")),
      "missing",
    );

    const report = await repairExistingConfigFiles({ userConfigRoot: root });

    expect(report.results).toEqual([]);
    expect(report.errors).toEqual([]);
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("compacts valid files, resets invalid files, backs up rewrites, and is idempotent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-clearance-repair-"));
    const globalPath = path.join(root, "global.json");
    const overlayPath = path.join(
      root,
      "projects",
      "project-key",
      "overlay.json",
    );
    const missingOverlayPath = path.join(
      root,
      "projects",
      "empty-project",
      "overlay.json",
    );
    const globalOriginal = {
      version: 1,
      mode: "ask",
      unknownToolPosture: "allow",
      packs: [],
      packEnablement: {
        enabledPackagePacks: [],
        disabledPackagePacks: [],
        disabledConfigPacks: [],
      },
      reviewer: {
        promptPosture: "reviewer.default",
        promptAppends: [],
        projectPromptAppends: [],
        promptOverride: null,
        model: "openai/example",
        tokenBudget: { window: "24h", limit: null },
        contextMode: "recentContext",
        recentContext: {
          decisionLimit: 25,
          decisionWindow: "2h",
          conversationTurns: 3,
          userTurns: 5,
          conversationCharLimit: 6000,
        },
        escalation: { enabled: true, denialLimit: 3, window: "10m" },
      },
      display: {
        reviewNote: {
          mode: "reason+accent",
          showModelLabel: false,
          accent: true,
        },
      },
    };
    const invalidOriginal = "{ not valid json\n";

    await writeJson(globalPath, globalOriginal);
    await mkdir(path.dirname(overlayPath), { recursive: true });
    await writeFile(overlayPath, invalidOriginal, "utf8");
    await mkdir(path.dirname(missingOverlayPath), { recursive: true });

    const first = await repairExistingConfigFiles({ userConfigRoot: root });

    expect(first.errors).toEqual([]);
    expect(first.results).toEqual([
      {
        path: globalPath,
        kind: "global",
        action: "compacted",
        backupPath: `${globalPath}.bak`,
      },
      {
        path: overlayPath,
        kind: "project",
        action: "reset",
        backupPath: `${overlayPath}.bak`,
      },
    ]);
    await expect(readFile(globalPath, "utf8")).resolves.toBe(
      `${JSON.stringify({ version: 1, reviewer: { model: "openai/example" } }, null, 2)}\n`,
    );
    await expect(readFile(`${globalPath}.bak`, "utf8")).resolves.toBe(
      `${JSON.stringify(globalOriginal, null, 2)}\n`,
    );
    await expect(readFile(overlayPath, "utf8")).resolves.toBe(
      emptyConfigText(),
    );
    await expect(readFile(`${overlayPath}.bak`, "utf8")).resolves.toBe(
      invalidOriginal,
    );
    await expect(readFile(missingOverlayPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const second = await repairExistingConfigFiles({ userConfigRoot: root });
    expect(second.errors).toEqual([]);
    expect(second.results).toEqual([
      { path: globalPath, kind: "global", action: "unchanged" },
      { path: overlayPath, kind: "project", action: "unchanged" },
    ]);
    expect(
      (await readdir(path.dirname(globalPath))).filter((entry) =>
        entry.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  it("aggregates a repair error and continues with sibling files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-clearance-repair-"));
    const globalPath = path.join(root, "global.json");
    const overlayPath = path.join(
      root,
      "projects",
      "project-key",
      "overlay.json",
    );
    const globalOriginal = {
      version: 1,
      mode: "auto",
      unknownToolPosture: "allow",
    };
    await writeJson(globalPath, globalOriginal);
    await writeJson(overlayPath, {
      version: 1,
      projectScope: {
        roots: ["packages"],
        safeHomeUseDefaults: false,
        agentSupportDirectories: [],
      },
    });

    const report = await repairExistingConfigFiles({
      userConfigRoot: root,
      fileSystem: {
        copyFile: async (sourcePath, destinationPath) => {
          if (destinationPath === `${globalPath}.bak`) {
            throw new Error("injected backup failure");
          }
          await copyFile(sourcePath, destinationPath);
        },
      },
    });

    expect(report.errors).toEqual([
      {
        path: globalPath,
        kind: "global",
        message: "injected backup failure",
      },
    ]);
    expect(report.results).toEqual([
      {
        path: overlayPath,
        kind: "project",
        action: "compacted",
        backupPath: `${overlayPath}.bak`,
      },
    ]);
    await expect(readFile(globalPath, "utf8")).resolves.toBe(
      `${JSON.stringify(globalOriginal, null, 2)}\n`,
    );
    await expect(readFile(overlayPath, "utf8")).resolves.toBe(
      `${JSON.stringify(
        { version: 1, projectScope: { roots: ["packages"], safeHomeUseDefaults: false } },
        null,
        2,
      )}\n`,
    );
  });

  it("reports symlinked files and project directories without following or replacing them", async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-clearance-repair-"));
    const outside = await mkdtemp(path.join(tmpdir(), "pi-clearance-symlink-"));
    const globalPath = path.join(root, "global.json");
    const globalTarget = path.join(outside, "global.json");
    const realProjectDir = path.join(root, "projects", "real-project");
    const overlayPath = path.join(realProjectDir, "overlay.json");
    const overlayTarget = path.join(outside, "overlay.json");
    const linkedProjectPath = path.join(root, "projects", "linked-project");
    const linkedProjectTarget = path.join(outside, "linked-project");

    await writeJson(globalTarget, { version: 1, mode: "auto" });
    await writeJson(overlayTarget, { version: 1, promptAppends: ["keep"] });
    await writeJson(path.join(linkedProjectTarget, "overlay.json"), {
      version: 1,
      promptAppends: ["keep linked"],
    });
    await mkdir(realProjectDir, { recursive: true });

    try {
      await symlink(globalTarget, globalPath, "file");
      await symlink(overlayTarget, overlayPath, "file");
      await symlink(
        linkedProjectTarget,
        linkedProjectPath,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EPERM"
      ) {
        context.skip();
        return;
      }
      throw error;
    }

    const report = await repairExistingConfigFiles({ userConfigRoot: root });

    expect(report.errors).toEqual([]);
    expect(report.results).toEqual(
      expect.arrayContaining([
        { path: globalPath, kind: "global", action: "skipped-symlink" },
        { path: overlayPath, kind: "project", action: "skipped-symlink" },
        {
          path: linkedProjectPath,
          kind: "project",
          action: "skipped-symlink",
        },
      ]),
    );
    expect(report.results).toHaveLength(3);
    await expect(readFile(globalTarget, "utf8")).resolves.toBe(
      `${JSON.stringify({ version: 1, mode: "auto" }, null, 2)}\n`,
    );
    await expect(readFile(overlayTarget, "utf8")).resolves.toBe(
      `${JSON.stringify({ version: 1, promptAppends: ["keep"] }, null, 2)}\n`,
    );
    expect((await lstat(globalPath)).isSymbolicLink()).toBe(true);
    expect((await lstat(overlayPath)).isSymbolicLink()).toBe(true);
  });

  it("resets obsolete schema versions instead of translating them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-clearance-repair-"));
    const globalPath = path.join(root, "global.json");
    const obsolete = { version: 2, mode: "auto" };
    await writeJson(globalPath, obsolete);

    const report = await repairExistingConfigFiles({ userConfigRoot: root });

    expect(report.errors).toEqual([]);
    expect(report.results[0]).toMatchObject({ action: "reset" });
    await expect(readFile(globalPath, "utf8")).resolves.toBe(emptyConfigText());
    await expect(readFile(`${globalPath}.bak`, "utf8")).resolves.toBe(
      `${JSON.stringify(obsolete, null, 2)}\n`,
    );
  });
});
