import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginHost } from "../src/host.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(rename).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([["plugin", false], ["checkout", false], ["plugin", true]] as const)("preserves the existing %s on publication failure (restoration fails: %s)", async (kind, restoreFails) => {
  const root = await mkdtemp(join(tmpdir(), "pi-plugins-replacement-"));
  roots.push(root);
  const repository = join(root, "source");
  await mkdir(join(repository, ".claude-plugin"), { recursive: true });
  await mkdir(join(repository, "plugins/demo"), { recursive: true });
  await writeFile(join(repository, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "market", plugins: [{ name: "demo", source: "plugins/demo" }] }));
  await writeFile(join(repository, "plugins/demo/payload.txt"), "working version");
  const host = createPluginHost(join(root, "agent"));
  const market = await host.addMarketplace(repository);
  const installed = await host.installPlugin("market", "demo");
  await writeFile(join(repository, "plugins/demo/payload.txt"), "new version");
  const target = kind === "plugin" ? installed.root : market.checkout;
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let failed = false;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (to === target && (!failed || restoreFails)) {
      failed = true;
      throw Object.assign(new Error("fixture rename failure"), { code: "EACCES" });
    }
    return actual.rename(from, to);
  });
  const operation = kind === "plugin" ? host.updatePlugin("market", "demo") : host.refreshMarketplace("market");
  await expect(operation).rejects.toThrow(restoreFails ? /previous copy retained at/u : /fixture rename failure/u);
  expect(failed).toBe(true);
  const holdings = (await readdir(dirname(target))).filter((name) => name.startsWith(".replacing-"));
  if (restoreFails) {
    expect(holdings).toHaveLength(1);
    expect(await readFile(join(dirname(target), holdings[0]!, "previous/payload.txt"), "utf8")).toBe("working version");
  } else {
    const payload = kind === "plugin" ? join(target, "payload.txt") : join(target, "plugins/demo/payload.txt");
    expect(await readFile(payload, "utf8")).toBe("working version");
    expect(holdings).toEqual([]);
  }
});
