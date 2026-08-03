import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getProgrammaticCachePath,
  loadProgrammaticCache,
  saveProgrammaticCache,
} from "../programmatic-cache.ts";

let savedAgentDir: string | undefined;

beforeEach(() => {
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-mcp-cache-test-"));
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

describe("programmatic tool cache", () => {
  it("returns null when no cache file exists", () => {
    expect(loadProgrammaticCache()).toBeNull();
  });

  it("round-trips entries keyed by qualified server key", () => {
    saveProgrammaticCache({
      version: 1,
      servers: {
        "programmatic:abc": {
          tools: [{ name: "echo", description: "Echo." }, { name: "shot" }],
          cachedAt: 123,
        },
      },
    });
    const cache = loadProgrammaticCache();
    expect(cache?.servers["programmatic:abc"]?.tools.map((tool) => tool.name)).toEqual(["echo", "shot"]);
  });

  it("replaces rather than merges, so pruned sources stay pruned", () => {
    saveProgrammaticCache({
      version: 1,
      servers: { "programmatic:old": { tools: [{ name: "gone" }], cachedAt: 1 } },
    });
    saveProgrammaticCache({
      version: 1,
      servers: { "programmatic:new": { tools: [{ name: "kept" }], cachedAt: 2 } },
    });
    const cache = loadProgrammaticCache();
    expect(Object.keys(cache?.servers ?? {})).toEqual(["programmatic:new"]);
  });

  it("drops malformed entries but keeps valid ones", () => {
    writeFileSync(getProgrammaticCachePath(), JSON.stringify({
      version: 1,
      servers: {
        "programmatic:good": { tools: [{ name: "echo" }], cachedAt: 1 },
        "programmatic:bad-tools": { tools: [{ description: "no name" }], cachedAt: 1 },
        "programmatic:bad-shape": "nonsense",
      },
    }));
    const cache = loadProgrammaticCache();
    expect(Object.keys(cache?.servers ?? {})).toEqual(["programmatic:good"]);
  });

  it("returns null for a corrupt cache file", () => {
    writeFileSync(getProgrammaticCachePath(), "not json{");
    expect(loadProgrammaticCache()).toBeNull();
  });
});
