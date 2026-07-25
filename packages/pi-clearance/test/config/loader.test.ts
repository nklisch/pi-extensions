import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/loader.ts";
import { resolveConfigPaths } from "../../src/config/paths.ts";

const originalXdg = process.env.XDG_CONFIG_HOME;
const tempRoots: string[] = [];

afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(rawGlobal?: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-clearance-loader-"));
  tempRoots.push(root);
  process.env.XDG_CONFIG_HOME = root;
  const cwd = path.join(root, "project");
  await mkdir(cwd, { recursive: true });
  if (rawGlobal !== undefined) {
    const configDir = path.join(root, "pi", "pi-clearance");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "global.json"),
      JSON.stringify(rawGlobal),
    );
  }
  return cwd;
}

describe("config loader tri-state mode", () => {
  it("uses ask when global config is missing and resolves built-in agent support roots", async () => {
    const config = await loadConfig({ cwd: await fixture() });
    expect(config.mode).toBe("ask");
    expect(config.errors).toHaveLength(0);
    expect(config.projectScope.agentSupportDirectories).toContain(
      path.join(os.homedir(), ".pi", "agent", "skills"),
    );
  });

  it("fails invalid legacy config closed without translation", async () => {
    const config = await loadConfig({
      cwd: await fixture({ version: 1, defaultPosture: "default" }),
    });
    expect(
      config.errors.some((error) => error.path.endsWith("global.json")),
    ).toBe(true);
    expect(config.mode).toBe("ask");
  });

  it("rejects the removed repository requireTrust key", async () => {
    const cwd = await fixture();
    const repoDir = path.join(cwd, ".pi-clearance");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      path.join(repoDir, "policy.json"),
      JSON.stringify({
        version: 1,
        requireTrust: true,
        packs: [],
        promptAppends: [],
      }),
    );

    const config = await loadConfig({ cwd });
    expect(config.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "schema",
          path: expect.stringContaining("policy.json"),
        }),
      ]),
    );
  });

  it("leaves legacy trusted.json files inert", async () => {
    const cwd = await fixture();
    const paths = resolveConfigPaths(cwd);
    await mkdir(paths.projectDir, { recursive: true });
    await writeFile(path.join(paths.projectDir, "trusted.json"), "not-json");

    const config = await loadConfig({ cwd, isProjectTrusted: true });
    expect(config.errors).toEqual([]);
    expect(config.trustedProject).toEqual({ trusted: true });
  });
});
