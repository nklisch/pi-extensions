import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentsContextExtension, { OPEN_TAG } from "./agents-context";

type HandlerEvent = {
  systemPrompt?: string;
};
type HandlerRet = { systemPrompt: string } | undefined | void;

/** Build a fake pi that captures the before_agent_start handler, like nates-toolkit.test. */
function load() {
  let handler: ((e: HandlerEvent, ctx?: { cwd?: string }) => HandlerRet) | null = null;
  const pi = {
    on: (event: string, h: (e: HandlerEvent, ctx?: { cwd?: string }) => HandlerRet) => {
      if (event === "before_agent_start") handler = h;
    },
  };
  agentsContextExtension(pi);
  return {
    fire: (e: HandlerEvent, ctx?: { cwd?: string }) => handler?.(e, ctx) || undefined,
    hasHandler: () => handler !== null,
  };
}

describe("agents-context extension", () => {
  let dir: string;

  // Fresh temp dir per test → unique absPath → the module-level mtime cache
  // never leaks a stale entry between tests.
  function freshDir(): string {
    const d = mkdtempSync(join(tmpdir(), "agents-context-"));
    return d;
  }

  test("registers a before_agent_start handler", () => {
    dir = freshDir();
    try {
      expect(load().hasHandler()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no-op (returns undefined) when .agents/AGENTS.md is absent", () => {
    dir = freshDir();
    try {
      const { fire } = load();
      expect(fire({ systemPrompt: "BASE" }, { cwd: dir })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("injects file content wrapped in the project_instructions tag, after the base", () => {
    dir = freshDir();
    try {
      mkdirSync(join(dir, ".agents"), { recursive: true });
      writeFileSync(join(dir, ".agents", "AGENTS.md"), "# House rules\n- be kind");
      const { fire } = load();
      const res = fire({ systemPrompt: "BASE" }, { cwd: dir });
      expect(res).toBeDefined();
      const sp = (res as { systemPrompt: string }).systemPrompt;
      expect(sp.startsWith("BASE")).toBe(true);
      expect(sp).toContain(OPEN_TAG);
      expect(sp).toContain("# House rules");
      expect(sp).toContain("- be kind");
      expect(sp).toContain("</project_instructions>");
      // The block is appended after the base, not replacing it.
      expect(sp.indexOf("BASE")).toBeLessThan(sp.indexOf(OPEN_TAG));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("idempotent: skips when the tag is already in the base prompt", () => {
    dir = freshDir();
    try {
      mkdirSync(join(dir, ".agents"), { recursive: true });
      writeFileSync(join(dir, ".agents", "AGENTS.md"), "rules");
      const { fire } = load();
      const baseWithTag = `BASE\n\n${OPEN_TAG}\nrules\n</project_instructions>`;
      expect(fire({ systemPrompt: baseWithTag }, { cwd: dir })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("whitespace-only file is treated as a no-op", () => {
    dir = freshDir();
    try {
      mkdirSync(join(dir, ".agents"), { recursive: true });
      writeFileSync(join(dir, ".agents", "AGENTS.md"), "   \n  \t ");
      const { fire } = load();
      expect(fire({ systemPrompt: "BASE" }, { cwd: dir })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("picks up edits once the file's mtime advances (cache invalidation)", () => {
    dir = freshDir();
    try {
      mkdirSync(join(dir, ".agents"), { recursive: true });
      const file = join(dir, ".agents", "AGENTS.md");
      writeFileSync(file, "version-1");
      const { fire } = load();
      const r1 = fire({ systemPrompt: "B" }, { cwd: dir }) as {
        systemPrompt: string;
      };
      expect(r1.systemPrompt).toContain("version-1");

      // Rewrite, then force a strictly-later mtime so the cache check must miss
      // regardless of filesystem mtime resolution (some FSes are 1s granularity).
      writeFileSync(file, "version-2");
      const later = Date.now() / 1000 + 5;
      utimesSync(file, later, later);

      const r2 = fire({ systemPrompt: "B" }, { cwd: dir }) as {
        systemPrompt: string;
      };
      expect(r2.systemPrompt).toContain("version-2");
      expect(r2.systemPrompt).not.toContain("version-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses the active context when switching workspaces", () => {
    const first = freshDir();
    const second = freshDir();
    try {
      for (const [path, rules] of [[first, "first workspace"], [second, "second workspace"]] as const) {
        mkdirSync(join(path, ".agents"));
        writeFileSync(join(path, ".agents/AGENTS.md"), rules);
      }
      const { fire } = load();
      expect(fire({ systemPrompt: "BASE" }, { cwd: first })?.systemPrompt).toContain("first workspace");
      const next = fire({ systemPrompt: "BASE" }, { cwd: second })?.systemPrompt;
      expect(next).toContain("second workspace");
      expect(next).not.toContain("first workspace");
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("falls back to process.cwd() when the context omits cwd", () => {
    dir = freshDir();
    const cwd = spyOn(process, "cwd").mockReturnValue(dir);
    try {
      mkdirSync(join(dir, ".agents"));
      writeFileSync(join(dir, ".agents/AGENTS.md"), "fallback rules");
      expect(load().fire({ systemPrompt: "BASE" })?.systemPrompt).toContain("fallback rules");
    } finally {
      cwd.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
