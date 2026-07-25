import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AuditEntry,
  createConfigEventEntry,
  noopAuditSink,
} from "../../src/audit/log.ts";
import { createDefaultAuditSink } from "../../src/runtime/sink.ts";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(
    path.join(tmpdir(), "pi-clearance-runtime-sink-"),
  );
  tempRoots.push(root);
  return root;
}

function configEntry(errors: readonly string[] = []): AuditEntry {
  return createConfigEventEntry(
    {
      entryType: "config.event",
      event: errors.length === 0 ? "config-loaded" : "config-load-failed",
      ...(errors.length === 0 ? {} : { errors }),
    },
    { clock: () => new Date("2026-06-25T00:00:00.000Z") },
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("createDefaultAuditSink", () => {
  it("writes JSON-line entries to audit.log under the configured root", () => {
    const root = tempRoot();
    const sink = createDefaultAuditSink({ userConfigRoot: root });

    sink.appendSync(configEntry());
    sink.appendSync(configEntry());

    const logPath = path.join(root, "audit.log");
    const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      entryType: "config.event",
      event: "config-loaded",
    });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      entryType: "config.event",
      event: "config-loaded",
    });
  });

  it("rotates audit.log when the sink threshold is exceeded", () => {
    const root = tempRoot();
    const sink = createDefaultAuditSink({ userConfigRoot: root });
    const logPath = path.join(root, "audit.log");

    sink.appendSync(configEntry(["x".repeat(11 * 1024 * 1024)]));
    sink.appendSync(configEntry());

    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(JSON.parse(readFileSync(logPath, "utf8")).event).toBe(
      "config-loaded",
    );
  });

  it("degrades to noopAuditSink if the directory cannot be created", () => {
    const root = tempRoot();
    const blocker = path.join(root, "not-a-directory");
    const unwritableRoot = path.join(blocker, "child");
    writeFileSync(blocker, "file blocks mkdir recursion", "utf8");

    const sink = createDefaultAuditSink({ userConfigRoot: unwritableRoot });

    expect(sink).toBe(noopAuditSink);
    expect(() => sink.appendSync(configEntry())).not.toThrow();
    expect(existsSync(path.join(unwritableRoot, "audit.log"))).toBe(false);
  });
});
