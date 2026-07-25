import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AuditEntry,
  createArrayAuditSink,
  createConfigEventEntry,
  createRotatingFileSink,
  noopAuditSink,
} from "../../src/audit/log.ts";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-auto-approve-audit-sink-"));
  tempRoots.push(root);
  return root;
}

function configEntry(event: "config-loaded" | "mode-selected"): AuditEntry {
  return createConfigEventEntry(
    {
      entryType: "config.event",
      event,
      ...(event === "mode-selected" ? { mode: "ask" as const } : {}),
    },
    { clock: () => new Date("2026-06-25T00:00:00.000Z") },
  );
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").trimEnd().split("\n");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("audit sinks", () => {
  it("provides a no-op sink that never throws", () => {
    expect(() =>
      noopAuditSink.appendSync(configEntry("config-loaded")),
    ).not.toThrow();
  });

  it("captures array sink entries in order and supports clear", () => {
    const sink = createArrayAuditSink();
    const first = configEntry("config-loaded");
    const second = configEntry("mode-selected");

    sink.appendSync(first);
    sink.appendSync(second);

    expect(sink.entries).toEqual([first, second]);

    sink.clear();

    expect(sink.entries).toEqual([]);
  });

  it("writes one JSON-serialized audit entry per line", () => {
    const path = join(tempRoot(), "audit.log");
    const sink = createRotatingFileSink({ path, maxSizeBytes: 1024 });

    sink.appendSync(configEntry("config-loaded"));
    sink.appendSync(configEntry("mode-selected"));

    const writtenLines = lines(path);
    expect(writtenLines).toHaveLength(2);
    expect(JSON.parse(writtenLines[0] ?? "{}")).toMatchObject({
      entryType: "config.event",
      event: "config-loaded",
    });
    expect(JSON.parse(writtenLines[1] ?? "{}")).toMatchObject({
      entryType: "config.event",
      event: "mode-selected",
    });
  });

  it("rotates files when the current file exceeds the size threshold", () => {
    const path = join(tempRoot(), "audit.log");
    const sink = createRotatingFileSink({
      path,
      maxSizeBytes: 150,
      maxFiles: 3,
    });

    sink.appendSync(configEntry("config-loaded"));
    sink.appendSync(configEntry("mode-selected"));
    sink.appendSync(configEntry("config-loaded"));
    sink.appendSync(configEntry("mode-selected"));
    sink.appendSync(configEntry("config-loaded"));

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);

    expect(JSON.parse(lines(path)[0] ?? "{}")).toMatchObject({
      event: "config-loaded",
    });
    expect(JSON.parse(lines(`${path}.1`)[0] ?? "{}")).toMatchObject({
      event: "config-loaded",
    });
    expect(JSON.parse(lines(`${path}.1`)[1] ?? "{}")).toMatchObject({
      event: "mode-selected",
    });
    expect(JSON.parse(lines(`${path}.2`)[0] ?? "{}")).toMatchObject({
      event: "config-loaded",
    });
  });

  it("keeps at most maxFiles rotated files", () => {
    const path = join(tempRoot(), "audit.log");
    const sink = createRotatingFileSink({
      path,
      maxSizeBytes: 150,
      maxFiles: 2,
    });

    for (let index = 0; index < 7; index += 1) {
      sink.appendSync(configEntry("config-loaded"));
    }

    const auditFiles = readdirSync(join(path, "..")).filter((file) =>
      file.startsWith(basename(path)),
    );

    expect(auditFiles).toContain("audit.log");
    expect(auditFiles).toContain("audit.log.1");
    expect(auditFiles).toContain("audit.log.2");
    expect(auditFiles).not.toContain("audit.log.3");
  });

  it("swallows serialization errors", () => {
    const path = join(tempRoot(), "audit.log");
    const sink = createRotatingFileSink({ path });
    const circular = configEntry("config-loaded") as unknown as Record<
      string,
      unknown
    >;
    circular.self = circular;

    expect(() =>
      sink.appendSync(circular as unknown as AuditEntry),
    ).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
