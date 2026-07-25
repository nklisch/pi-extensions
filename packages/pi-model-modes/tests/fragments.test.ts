import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  statSync,
} from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import {
  AXES,
  discoverAxis,
  discoverModifiers,
  discoverBaseOverlays,
  loadFragment,
  setFragmentRootForTesting,
  resetFragmentsForTesting,
} from "../src/fragments.js";

/**
 * Tests for `src/fragments.ts` — convention-directory discovery + the
 * stat/mtime-invalidated content cache. Mirrors `cache.test.ts` idioms:
 * `beforeEach(resetFragmentsForTesting)` isolates module state, and every
 * behavioral case runs against a temp fixture root via
 * `setFragmentRootForTesting`. The starter-set sanity case alone uses the REAL
 * package root (no override). No module mocking — the no-re-read half of the
 * mtime contract is proven by an out-of-band write WITHOUT an mtime bump.
 */

let tmp: string | undefined;

/** Create a fresh temp fixture root and point the loader at it. */
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "frag-"));
  tmp = root;
  setFragmentRootForTesting(root);
  return root;
}

/** Write a file, creating parent dirs as needed. */
function write(root: string, rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

beforeEach(() => {
  resetFragmentsForTesting();
});

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
  resetFragmentsForTesting();
});

describe("discoverAxis — determinism + sorting", () => {
  it("returns absolute paths filename-sorted ascending, regardless of write order", () => {
    const root = freshRoot();
    write(root, "axis/agency/b.md", "B");
    write(root, "axis/agency/a.md", "A");
    write(root, "axis/agency/c.md", "C");

    const result = discoverAxis("agency");
    expect(result.map((p) => basename(p))).toEqual(["a.md", "b.md", "c.md"]);
    // absolute paths under the fixture root
    for (const p of result) {
      expect(p.startsWith(join(root, "axis", "agency"))).toBe(true);
    }
  });

  it("is repeatable: a second call yields an identical array (no unordered-key nondeterminism)", () => {
    const root = freshRoot();
    write(root, "axis/scope/z.md", "Z");
    write(root, "axis/scope/m.md", "M");
    write(root, "axis/scope/a.md", "A");

    expect(discoverAxis("scope")).toEqual(discoverAxis("scope"));
  });

  it("ignores non-.md files and subdirectories", () => {
    const root = freshRoot();
    write(root, "axis/quality/keep.md", "K");
    write(root, "axis/quality/skip.txt", "nope");
    mkdirSync(join(root, "axis/quality/nested"), { recursive: true });

    const result = discoverAxis("quality");
    expect(result.map((p) => basename(p))).toEqual(["keep.md"]);
  });
});

describe("discoverAxis — fail-fast", () => {
  it("throws on a missing axis dir", () => {
    freshRoot(); // root exists but no axis/agency dir
    expect(() => discoverAxis("agency")).toThrow(/axis dir not found/i);
  });

  it("throws on an empty axis dir (with a distinct message)", () => {
    const root = freshRoot();
    mkdirSync(join(root, "axis", "agency"), { recursive: true });
    expect(() => discoverAxis("agency")).toThrow(/is empty/i);
  });
});

describe("discoverModifiers — empty allowed, missing fails", () => {
  it("returns [] for an empty modifiers dir", () => {
    const root = freshRoot();
    mkdirSync(join(root, "modifiers"), { recursive: true });
    expect(discoverModifiers()).toEqual([]);
  });

  it("throws when the modifiers dir is missing", () => {
    freshRoot();
    expect(() => discoverModifiers()).toThrow(/modifiers dir not found/i);
  });

  it("returns sorted absolute .md paths when present", () => {
    const root = freshRoot();
    write(root, "modifiers/tdd.md", "T");
    write(root, "modifiers/careful.md", "C");
    expect(discoverModifiers().map((p) => basename(p))).toEqual([
      "careful.md",
      "tdd.md",
    ]);
  });
});

describe("discoverBaseOverlays — manifest order + fail-fast", () => {
  it("returns abs paths in manifest order, NOT re-sorted", () => {
    const root = freshRoot();
    // Manifest order (z, a, m) deliberately differs from sort order (a, m, z).
    write(root, "base/z.md", "Z");
    write(root, "base/a.md", "A");
    write(root, "base/m.md", "M");
    write(
      root,
      "base.json",
      JSON.stringify({ overlays: ["base/z.md", "base/a.md", "base/m.md"] }),
    );

    const result = discoverBaseOverlays();
    expect(result.map((p) => basename(p))).toEqual(["z.md", "a.md", "m.md"]);
    expect(result).toEqual([
      join(root, "base/z.md"),
      join(root, "base/a.md"),
      join(root, "base/m.md"),
    ]);
  });

  it("throws when base.json is missing", () => {
    freshRoot();
    expect(() => discoverBaseOverlays()).toThrow(/base\.json not found/i);
  });

  it("throws on malformed overlays (not a string[])", () => {
    const root = freshRoot();
    write(root, "base.json", JSON.stringify({ overlays: "x" }));
    expect(() => discoverBaseOverlays()).toThrow(/must be a string\[\]/i);
  });

  it("throws on malformed overlays (array of non-strings)", () => {
    const root = freshRoot();
    write(root, "base.json", JSON.stringify({ overlays: [1, 2] }));
    expect(() => discoverBaseOverlays()).toThrow(/must be a string\[\]/i);
  });

  it("throws on unparseable base.json", () => {
    const root = freshRoot();
    write(root, "base.json", "{ not json");
    expect(() => discoverBaseOverlays()).toThrow(/unparseable/i);
  });

  it("throws on an orphaned manifest entry (referenced overlay missing)", () => {
    const root = freshRoot();
    write(root, "base/present.md", "P");
    write(
      root,
      "base.json",
      JSON.stringify({ overlays: ["base/present.md", "base/missing.md"] }),
    );
    expect(() => discoverBaseOverlays()).toThrow(/missing overlay/i);
  });

  it("throws when an overlay entry escapes the fragment root via ../", () => {
    const root = freshRoot();
    // A real file exists OUTSIDE the root; the manifest must not be able to
    // reach it through a `../` escape.
    write(root, "../escapee.md", "SECRET");
    write(root, "base.json", JSON.stringify({ overlays: ["../escapee.md"] }));
    expect(() => discoverBaseOverlays()).toThrow(/escapes the fragment root/i);
  });

  it("throws when an overlay entry resolves to a directory, not a file", () => {
    const root = freshRoot();
    mkdirSync(join(root, "base/notafile.md"), { recursive: true }); // a DIR named like a file
    write(root, "base.json", JSON.stringify({ overlays: ["base/notafile.md"] }));
    expect(() => discoverBaseOverlays()).toThrow(/is not a file/i);
  });
});

describe("loadFragment — trimming + mtime invalidation", () => {
  it("returns trimmed content", () => {
    const root = freshRoot();
    const p = write(root, "axis/agency/x.md", "  \n# Heading\nbody\n\n  ");
    expect(loadFragment(p)).toBe("# Heading\nbody");
  });

  it("re-reads when mtime is bumped (live-edit takes effect)", () => {
    const root = freshRoot();
    const p = write(root, "axis/agency/x.md", "original");
    expect(loadFragment(p)).toBe("original");

    // Edit content, then force a distinct mtimeMs (no reliance on clock granularity).
    writeFileSync(p, "edited", "utf8");
    const future = Date.now() / 1000 + 3600; // 1h ahead, in seconds
    utimesSync(p, future, future);

    expect(loadFragment(p)).toBe("edited");
  });

  it("does NOT re-read when mtime is unchanged (out-of-band write proves the cache hit)", () => {
    const root = freshRoot();
    const p = write(root, "axis/agency/x.md", "cached-value");
    expect(loadFragment(p)).toBe("cached-value"); // populates the cache

    // Capture the current mtime, write new content out-of-band, then restore the
    // exact mtime so the cache cannot observe the change. A correct stat-gated
    // cache returns the STALE cached value; a read-every-call cache would not.
    const { mtimeMs } = statSync(p);
    writeFileSync(p, "stale-should-not-surface", "utf8");
    const secs = mtimeMs / 1000;
    utimesSync(p, secs, secs);
    expect(statSync(p).mtimeMs).toBe(mtimeMs); // mtime truly restored

    expect(loadFragment(p)).toBe("cached-value"); // STILL the cached value
  });

  it("throws on a missing path (fail fast)", () => {
    const root = freshRoot();
    expect(() => loadFragment(join(root, "nope.md"))).toThrow();
  });
});

describe("reset isolation", () => {
  it("resetFragmentsForTesting restores the package default root and empties the cache", () => {
    const root = freshRoot();
    const p = write(root, "axis/agency/x.md", "fixture");
    expect(loadFragment(p)).toBe("fixture");

    resetFragmentsForTesting();

    // Override cleared → discovery now resolves against the REAL package root,
    // which has a populated starter set (proves the override was reset).
    expect(() => discoverAxis("agency")).not.toThrow();
    const real = discoverAxis("agency");
    expect(real.length).toBeGreaterThan(0);
  });
});

describe("starter-set sanity (real package root, no override)", () => {
  it("each axis exposes its expected value names", () => {
    // No override — exercise the shipped prompts/ tree. All three axes are now
    // fully authored (filename-sorted ascending).
    expect(discoverAxis("agency").map((p) => basename(p, ".md"))).toEqual([
      "autonomous",
      "collaborative",
      "partner",
      "surgical",
    ]);
    expect(discoverAxis("quality").map((p) => basename(p, ".md"))).toEqual([
      "architect",
      "minimal",
      "pragmatic",
    ]);
    expect(discoverAxis("scope").map((p) => basename(p, ".md"))).toEqual([
      "adjacent",
      "narrow",
      "unrestricted",
    ]);
  });

  it("AXES covers exactly the three convention axes", () => {
    expect([...AXES]).toEqual(["agency", "quality", "scope"]);
  });

  it("modifiers exposes the full authored set, filename-sorted", () => {
    expect(discoverModifiers().map((p) => basename(p, ".md"))).toEqual([
      "bold",
      "context-pacing",
      "debug",
      "director",
      "flow",
      "methodical",
      "muse",
      "playful",
      "readonly",
      "speak-plain",
      "tdd",
    ]);
  });

  it("base overlays resolves to the shipped overlays in manifest order (chill, flow, pi-direct)", () => {
    const overlays = discoverBaseOverlays();
    expect(overlays.map((p) => basename(p, ".md"))).toEqual([
      "chill",
      "flow",
      "pi-direct",
    ]);
  });

  it("every discovered starter path loads to non-empty trimmed content", () => {
    const paths = [
      ...AXES.flatMap((a) => discoverAxis(a)),
      ...discoverModifiers(),
      ...discoverBaseOverlays(),
    ];
    expect(paths.length).toBe(24); // agency(4)+quality(3)+scope(3) + 11 modifiers + 3 overlays
    for (const p of paths) {
      const content = loadFragment(p);
      expect(content.length).toBeGreaterThan(0);
      expect(content).toBe(content.trim()); // already trimmed
    }
  });
});
