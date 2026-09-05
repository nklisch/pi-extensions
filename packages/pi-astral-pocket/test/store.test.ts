import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDigestSnapshot, digestScopeKey, ensureLayout, generatedNoteFile, readScopedSummary, readSummaryCapped, rerenderSummary, searchPocket, updateDigest, updateScopedDigest, writeNote } from "../src/store.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pocket-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("store layout", () => {
  it("creates SUMMARY.md, POCKET.md, and notes/ on first use", () => {
    ensureLayout(root);
    expect(readFileSync(join(root, "POCKET.md"), "utf8")).toContain("Registry");
    expect(readFileSync(join(root, "SUMMARY.md"), "utf8")).toContain("No notes yet");
  });
});

describe("writeNote", () => {
  it("writes a note file with frontmatter, a registry line, and a refreshed summary", () => {
    const file = writeNote(root, {
      title: "Use major-only ranges",
      body: "Inter-package deps use ^0 / ^2 carets.",
      keywords: ["deps", "versioning"],
      project: "/home/nathan/dev/pi-extensions",
    });
    const note = readFileSync(join(root, "notes", file), "utf8");
    expect(note).toContain("project: /home/nathan/dev/pi-extensions");
    expect(note).toContain("keywords: [deps, versioning]");
    expect(note).toContain("# Use major-only ranges");

    const registry = readFileSync(join(root, "POCKET.md"), "utf8");
    expect(registry).toContain(`- [Use major-only ranges](notes/${file}) — project — pi-extensions`);

    const summary = readFileSync(join(root, "SUMMARY.md"), "utf8");
    expect(summary).toContain("Use major-only ranges");
  });

  it("preserves pinned and digest sections across mechanical re-renders", () => {
    writeNote(root, { title: "first", body: "one" });
    const summaryPath = join(root, "SUMMARY.md");
    const withBlocks = readFileSync(summaryPath, "utf8")
      .replace(/(<!-- pocket:pinned:start -->)\n/, "$1\nAlways be terse.\n")
      .replace(/(<!-- pocket:digest:start -->)\n[\s\S]*?\n(<!-- pocket:digest:end -->)/, "$1\n- digested truth\n$2");
    writeFileSync(summaryPath, withBlocks, "utf8");

    writeNote(root, { title: "second", body: "two" });
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toContain("Always be terse.");
    expect(summary).toContain("- digested truth");
    expect(summary).toContain("second");
  });
});

describe("updateDigest", () => {
  it("replaces only the digest block", () => {
    writeNote(root, { title: "first", body: "one" });
    expect(updateDigest(root, "- consolidated")).toBe(true);
    const summary = readFileSync(join(root, "SUMMARY.md"), "utf8");
    expect(summary).toContain("- consolidated");
    expect(summary).toContain("first");
  });
});

describe("searchPocket", () => {
  it("finds notes by keyword across registry and bodies", () => {
    writeNote(root, { title: "alpha decision", body: "chose sqlite for state", keywords: ["sqlite"], project: "/p/a" });
    writeNote(root, { title: "beta convention", body: "never pin patch floors", project: "/p/b" });
    const hits = searchPocket(root, "sqlite", "/p/a", 10, false, "all");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("alpha decision");
  });

  it("ranks current-project body hits first", () => {
    writeNote(root, { title: "other project", body: "shared keyword here", project: "/p/other" });
    writeNote(root, { title: "this project", body: "shared keyword here", project: "/p/current" });
    // Force both through the body-search path with a term absent from the registry lines.
    const hits = searchPocket(root, "shared", "/p/current", 10, false, "all");
    expect(hits[0]?.title).toBe("this project");
  });

  it("filters foreign and unknown notes before limits while explicit all recall retains provenance", () => {
    writeNote(root, { title: "repo A", body: "conflict choose sqlite", project: "/repo/a", projectId: "repo-a", scope: "project" });
    writeNote(root, { title: "repo B", body: "conflict choose files", project: "/repo/b", projectId: "repo-b", scope: "project" });
    writeNote(root, { title: "global preference", body: "conflict prefer concise output", scope: "global" });
    writeFileSync(join(root, "notes", "legacy-unknown.md"), "# Unknown legacy\n\nconflict old note\n", "utf8");

    const current = searchPocket(root, "conflict", "repo-a", 10);
    expect(current.map((hit) => hit.title)).toEqual(["repo A", "global preference"]);
    const all = searchPocket(root, "conflict", "repo-a", 10, false, "all");
    expect(all.map((hit) => hit.title)).toEqual(expect.arrayContaining(["repo A", "repo B", "global preference", "Unknown legacy"]));
    expect(all.find((hit) => hit.title === "Unknown legacy")?.scope).toBe("unknown");
  });

  it("builds scoped digest inputs and injection without reading the mixed legacy SUMMARY digest", () => {
    writeNote(root, { title: "repo A", body: "choose sqlite", projectId: "repo-a", project: "/repo/a", scope: "project" });
    writeNote(root, { title: "repo B", body: "choose files", projectId: "repo-b", project: "/repo/b", scope: "project" });
    writeNote(root, { title: "global", body: "prefer concise output", scope: "global" });
    updateDigest(root, "FOREIGN MIXED LEGACY DIGEST");

    const project = createDigestSnapshot(root, { kind: "project", projectId: "repo-a" });
    const global = createDigestSnapshot(root, { kind: "global" });
    expect(project.promptSource).toContain("choose sqlite");
    expect(project.promptSource).not.toContain("choose files");
    expect(project.promptSource).not.toContain("prefer concise");
    expect(global.promptSource).toContain("prefer concise");
    updateScopedDigest(root, { kind: "project", projectId: "repo-a" }, "- project digest [notes/a.md]");
    updateScopedDigest(root, { kind: "global" }, "- global digest [notes/g.md]");
    writeFileSync(join(root, "distilled.json"), JSON.stringify({
      sessions: {},
      digestFingerprints: {
        [digestScopeKey({ kind: "project", projectId: "repo-a" })]: project.fingerprint,
        [digestScopeKey({ kind: "global" })]: global.fingerprint,
      },
    }));
    const injected = readScopedSummary(root, "repo-a");
    expect(injected).toContain("project digest");
    expect(injected).toContain("global digest");
    expect(injected).not.toContain("FOREIGN MIXED");
    expect(injected).not.toContain("repo B");
  });

  it("returns body content for metadata matches, honors full excerpts, and searches old files", () => {
    ensureLayout(root);
    writeFileSync(join(root, "notes", "metadata-match.md"), [
      "---",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "project: unknown",
      "scope: global",
      `source_path: ${"long/source/header/".repeat(40)}`,
      "keywords: [registry-keyword]",
      "---",
      "",
      "# Different title",
      "",
      `BODY-MUST-APPEAR ${"x".repeat(1000)}`,
      "",
    ].join("\n"));
    const summarized = searchPocket(root, "registry-keyword", "project", 10);
    expect(summarized[0]?.excerpt).toContain("BODY-MUST-APPEAR");
    const full = searchPocket(root, "registry-keyword", "project", 10, true);
    expect(full[0]!.excerpt.length).toBeGreaterThan(summarized[0]!.excerpt.length);

    for (let i = 0; i < 205; i++) {
      writeFileSync(join(root, "notes", `legacy-${String(i).padStart(3, "0")}.md`), `---\nproject: /legacy/${i}\n---\n\n# Legacy ${i}\n\n${i === 0 ? "OLDEST-SIGNAL" : "ordinary"}\n`);
    }
    expect(searchPocket(root, "OLDEST-SIGNAL", "project", 10, false, "all")[0]?.title).toBe("Legacy 0");
  });

  it("requires all query terms to match", () => {
    writeNote(root, { title: "alpha", body: "sqlite state", keywords: ["sqlite"] });
    expect(searchPocket(root, "sqlite missing-term", undefined, 10, false, "all")).toHaveLength(0);
  });
});

describe("digest snapshot ordering", () => {
  it("caps by note time so a recent generated correction and manual note survive arbitrary filenames", () => {
    ensureLayout(root);
    for (let i = 0; i < 205; i++) {
      const date = "2030-01-01T00:00:00.000Z";
      writeFileSync(join(root, "notes", generatedNoteFile(`session-${i}`)), [
        "---", `created: ${date}`, `updated: ${date}`, "project: /repo", "project_id: repo", "scope: project", "source: distilled", "---",
        "", `# Generated ${i}`, "", i === 0 ? "old correction" : `body ${i}`, "",
      ].join("\n"));
    }
    writeFileSync(join(root, "notes", generatedNoteFile("recent-correction")), [
      "---", "created: 2025-01-01T00:00:00.000Z", "updated: 2031-01-01T00:00:00.000Z", "project: /repo", "project_id: repo", "scope: project", "source: distilled", "---",
      "", "# Corrected generated title", "", "RECENT-CORRECTION-MUST-APPEAR", "",
    ].join("\n"));
    writeFileSync(join(root, "notes", "000-manual.md"), [
      "---", "created: 2030-01-01T00:00:00.000Z", "updated: 2030-01-01T00:00:00.000Z", "project: /repo", "project_id: repo", "scope: project", "source: agent", "---",
      "", "# Manual title must survive", "", "MANUAL-MUST-APPEAR", "",
    ].join("\n"));

    const snapshot = createDigestSnapshot(root, { kind: "project", projectId: "repo" });
    expect(snapshot.noteCount).toBe(200);
    expect(snapshot.promptSource).toContain("TITLE: Corrected generated title");
    expect(snapshot.promptSource).toContain("RECENT-CORRECTION-MUST-APPEAR");
    expect(snapshot.promptSource).toContain("TITLE: Manual title must survive");
    expect(snapshot.promptSource).toContain("MANUAL-MUST-APPEAR");
  });
});

describe("readSummaryCapped", () => {
  it("truncates oversized summaries with a pointer to the registry", () => {
    ensureLayout(root);
    writeFileSync(join(root, "SUMMARY.md"), "x".repeat(500), "utf8");
    const capped = readSummaryCapped(root, 100);
    expect(capped.length).toBeLessThan(200);
    expect(capped).toContain("summary truncated");
  });
});

describe("rerenderSummary", () => {
  it("caps the recent-notes index at 20 entries", () => {
    ensureLayout(root);
    for (let i = 0; i < 25; i++) {
      writeNote(root, { title: `note-${String(i).padStart(2, "0")}`, body: "b" }, new Date(2026, 0, i + 1));
    }
    rerenderSummary(root);
    const summary = readFileSync(join(root, "SUMMARY.md"), "utf8");
    const recent = summary.split("## Recent notes")[1];
    expect(recent).toContain("note-24");
    expect(recent).not.toContain("note-00");
  });
});
