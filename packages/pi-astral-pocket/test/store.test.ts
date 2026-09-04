import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureLayout, readSummaryCapped, rerenderSummary, searchPocket, updateDigest, writeNote } from "../src/store.js";

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
    expect(registry).toContain(`- [Use major-only ranges](notes/${file}) — deps, versioning — pi-extensions`);

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
    const hits = searchPocket(root, "sqlite", undefined, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("alpha decision");
  });

  it("ranks current-project body hits first", () => {
    writeNote(root, { title: "other project", body: "shared keyword here", project: "/p/other" });
    writeNote(root, { title: "this project", body: "shared keyword here", project: "/p/current" });
    // Force both through the body-search path with a term absent from the registry lines.
    const hits = searchPocket(root, "shared", "/p/current", 10);
    expect(hits[0]?.title).toBe("this project");
  });

  it("requires all query terms to match", () => {
    writeNote(root, { title: "alpha", body: "sqlite state", keywords: ["sqlite"] });
    expect(searchPocket(root, "sqlite missing-term", undefined, 10)).toHaveLength(0);
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
