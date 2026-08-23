import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactGc } from "../../../src/infrastructure/convergence/artifact-gc.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("convergence startup stat-only budget", () => {
  it("sweeps a populated fixture with the 2-second / 128-item foreground budget", async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), "pi-convergence-perf-"));
    roots.push(hostRoot);
    const pluginRoot = join(hostRoot, "stores", "v1", "plugins");
    await mkdir(pluginRoot, { recursive: true });
    await Promise.all(Array.from({ length: 300 }, (_, index) => mkdir(join(pluginRoot, `${index.toString(16).padStart(64, "0")}`))));

    const gc = createArtifactGc({ hostRoot, maxItems: 128, budgetMs: 2_000 });
    const started = performance.now();
    const report = await gc.sweep({ referenced: new Set(), signal: new AbortController().signal });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(report.deferred).toBe(true);
    expect(report.removed).toBe(0);
    expect(report.retained).toBeGreaterThan(0);
  });
});
