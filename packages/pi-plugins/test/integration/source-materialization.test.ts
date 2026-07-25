import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNodeSourceMaterializers,
  verifyContentManifest,
  type MaterializedPlugin,
  type Sha256,
  type StagingSlot,
} from "../../src/index.js";

const execFile = promisify(execFileCallback);
const sha256: Sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const roots: string[] = [];
const networkPolicy = {
  lookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
  privateOrigins: [
    "https://fixture.test",
    "https://registry.fixture.test",
  ],
};

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFile("git", [...args], { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function fixtureRepository(): Promise<Readonly<{ root: string; revision: string }>> {
  const root = await mkdtemp(join(tmpdir(), "pi-materialization-integration-git-"));
  roots.push(root);
  await runGit(root, ["init", "--quiet", "-b", "main"]);
  await runGit(root, ["config", "user.email", "fixture@example.test"]);
  await runGit(root, ["config", "user.name", "fixture"]);
  await mkdir(join(root, "plugins", "demo"), { recursive: true });
  await writeFile(join(root, "marketplace.json"), "{\"name\":\"fixture\"}\n", "utf8");
  await writeFile(join(root, "plugins", "demo", "index.js"), "export const fixture = true;\n", "utf8");
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "--quiet", "-m", "fixture"]);
  return { root, revision: await runGit(root, ["rev-parse", "HEAD"]) };
}

async function gitWrapper(repository: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-materialization-integration-bin-"));
  roots.push(root);
  const executable = join(root, "git-fixture-wrapper.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "remote" && args[1] === "add") {
  const approved = args[args.length - 1];
  args[args.length - 1] = ${JSON.stringify(repository)};
  execFileSync("git", args, { stdio: "inherit" });
  execFileSync("git", ["config", "pluginhost.approvedRemote", approved], { stdio: "inherit" });
} else if (args[0] === "remote" && args[1] === "get-url") {
  process.stdout.write(execFileSync("git", ["config", "--get", "pluginhost.approvedRemote"]));
} else {
  execFileSync("git", args, { stdio: "inherit" });
}
`, "utf8");
  await chmod(executable, 0o755);
  return executable;
}

function tarOctal(value: number, length: number): Uint8Array {
  return new TextEncoder().encode(value.toString(8).padStart(length - 1, "0") + "\0");
}

function tarEntry(name: string, body: string, type = "0"): Uint8Array {
  const header = new Uint8Array(512);
  const encoder = new TextEncoder();
  header.set(encoder.encode(name).slice(0, 100), 0);
  header.set(tarOctal(0o644, 8), 100);
  header.set(tarOctal(0, 8), 108);
  header.set(tarOctal(0, 8), 116);
  const bytes = encoder.encode(body);
  header.set(tarOctal(bytes.byteLength, 12), 124);
  header.set(tarOctal(0, 12), 136);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
  return new Uint8Array([
    ...header,
    ...bytes,
    ...new Uint8Array((512 - (bytes.byteLength % 512)) % 512),
  ]);
}

function npmTarball(): Uint8Array {
  const packageJson = JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { preinstall: "touch should-not-run" } });
  return gzipSync(new Uint8Array([
    ...tarEntry("package/", "", "5"),
    ...tarEntry("package/package.json", packageJson),
    ...tarEntry("package/index.js", "export const npmFixture = true;\n"),
    ...new Uint8Array(1024),
  ]));
}

async function slot(): Promise<StagingSlot> {
  const root = await mkdtemp(join(tmpdir(), "pi-materialization-integration-slot-"));
  roots.push(root);
  return { root };
}

function npmFetch(tarball: Uint8Array): typeof globalThis.fetch {
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  return async (input) => {
    const url = String(input);
    if (url === "https://registry.fixture.test/fixture") {
      return new Response(JSON.stringify({
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            version: "1.0.0",
            dist: { tarball: "https://registry.fixture.test/fixture-1.0.0.tgz", integrity },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://registry.fixture.test/fixture-1.0.0.tgz") {
      return new Response(Buffer.from(tarball), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Node source materializer composition", () => {
  it("materializes every source form through one verified handoff", async () => {
    const repository = await fixtureRepository();
    const git = await gitWrapper(repository.root);
    const tarball = npmTarball();
    const materializers = createNodeSourceMaterializers({
      gitExecutable: git,
      fetch: npmFetch(tarball),
      credentialProvider: { apply() {} },
      networkPolicy,
    });

    const marketplaces = await Promise.all([
      materializers.marketplaces.materialize({ kind: "local-git", path: repository.root }, await slot(), new AbortController().signal),
      materializers.marketplaces.materialize({ kind: "git", url: "https://fixture.test/marketplace.git", ref: "main" }, await slot(), new AbortController().signal),
      materializers.marketplaces.materialize({ kind: "github", repository: "fixture/marketplace", ref: "main" }, await slot(), new AbortController().signal),
    ]);
    expect(new Set(marketplaces.map((result) => result.content.rootDigest)).size).toBe(1);
    expect(new Set(marketplaces.map((result) => result.source.revision)).size).toBe(1);
    expect(marketplaces[0]!.source.revision).toBe(repository.revision);
    for (const result of marketplaces) {
      expect(result.root).toContain("/content");
      expect(await readdir(join(result.root, ".."))).toEqual(["content"]);
      expect(verifyContentManifest(result.content, sha256).rootDigest).toBe(result.content.rootDigest);
      expect(await materializers.verifyMaterializedContent(result.root, result.content)).toEqual(result.content);
      expect(await readFile(join(result.root, "marketplace.json"), "utf8")).toContain("fixture");
    }

    const context = {
      kind: "marketplace" as const,
      root: marketplaces[0]!.root,
      source: marketplaces[0]!.source,
      contentRootDigest: marketplaces[0]!.content.rootDigest,
      content: marketplaces[0]!.content,
      binding: marketplaces[0]!.binding,
    };
    const pluginSources: Array<Promise<MaterializedPlugin>> = [
      materializers.plugins.materialize({ kind: "git", url: "https://fixture.test/plugin.git", ref: "main" }, { kind: "external" }, await slot(), new AbortController().signal),
      materializers.plugins.materialize({ kind: "git-subdir", url: "https://fixture.test/plugin.git", path: "plugins/demo", ref: "main" }, { kind: "external" }, await slot(), new AbortController().signal),
      materializers.plugins.materialize({ kind: "marketplace-path", path: "plugins/demo" }, context, await slot(), new AbortController().signal),
      materializers.plugins.materialize({ kind: "npm", package: "fixture", registry: "https://registry.fixture.test/" }, { kind: "external" }, await slot(), new AbortController().signal),
    ];
    const plugins = await Promise.all(pluginSources);
    expect(plugins.map((result) => result.source.kind)).toEqual(["git", "git-subdir", "marketplace-path", "npm"]);
    for (const result of plugins) {
      expect(result.root).toContain("/content");
      expect(await readdir(join(result.root, ".."))).toEqual(["content"]);
      expect(result.content.entries.length).toBeGreaterThan(0);
      expect(verifyContentManifest(result.content, sha256).rootDigest).toBe(result.content.rootDigest);
    }
    expect(plugins[1]!.content.rootDigest).toBe(plugins[2]!.content.rootDigest);
    expect(await readFile(join(plugins[1]!.root, "index.js"), "utf8")).toContain("fixture");
    expect(await readFile(join(plugins[2]!.root, "index.js"), "utf8")).toContain("fixture");
    expect(await readFile(join(plugins[3]!.root, "index.js"), "utf8")).toContain("npmFixture");
    await expect(readFile(join(plugins[3]!.root, "should-not-run"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces catalog-derived egress before Git/fetch execution or content writes", async () => {
    const fetch = vi.fn(async () => new Response("must not run", { status: 200 }));
    const binRoot = await mkdtemp(join(tmpdir(), "pi-no-network-bin-"));
    roots.push(binRoot);
    const materializers = createNodeSourceMaterializers({
      gitExecutable: join(binRoot, "credential-canary-git"),
      fetch,
      credentialProvider: { apply() { throw new Error("credential canary must not resolve"); } },
    });

    const gitDestination = await slot();
    await expect(materializers.plugins.materialize(
      { kind: "git", url: "https://2130706433/catalog-plugin.git" },
      { kind: "external" },
      gitDestination,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED", classification: "security" });
    await expect(readdir(gitDestination.root)).resolves.toEqual([]);

    const npmDestination = await slot();
    await expect(materializers.plugins.materialize(
      { kind: "npm", package: "catalog-plugin", registry: "https://[::ffff:127.0.0.1]/" },
      { kind: "external" },
      npmDestination,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED", classification: "security" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(readdir(npmDestination.root)).resolves.toEqual([]);
  });

  it("preserves cancellation and transient failure semantics without leaving staging paths", async () => {
    const repository = await fixtureRepository();
    const git = await gitWrapper(repository.root);
    const materializers = createNodeSourceMaterializers({ gitExecutable: git, credentialProvider: { apply() {} }, networkPolicy });
    const controller = new AbortController();
    const reason = new Error("fixture cancellation");
    controller.abort(reason);
    const destination = await slot();
    await expect(materializers.marketplaces.materialize(
      { kind: "local-git", path: repository.root }, destination, controller.signal,
    )).rejects.toBe(reason);
    await expect(readdir(destination.root)).resolves.toEqual([]);

    const failing = createNodeSourceMaterializers({
      fetch: async () => new Response("temporary", { status: 503 }),
      credentialProvider: { apply() {} },
      networkPolicy,
    });
    const npmDestination = await slot();
    await expect(failing.plugins.materialize(
      { kind: "npm", package: "fixture", registry: "https://registry.fixture.test/" },
      { kind: "external" }, npmDestination, new AbortController().signal,
    )).rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED", classification: "transient" });
    await expect(readdir(npmDestination.root)).resolves.toEqual([]);
  });
});
