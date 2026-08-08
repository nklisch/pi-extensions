import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { classifyProcessIdentity, readProcessStartToken } from "../../../src/infrastructure/process/process-identity.js";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExecFileSync = vi.mocked(execFileSync);

function statWithStartToken(token: string): string {
  return `1 (node) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${token}`;
}

describe("process identity", () => {
  const kill = vi.spyOn(process, "kill");

  beforeEach(() => {
    kill.mockImplementation(() => true);
    mockedReadFileSync.mockReturnValue(statWithStartToken("42"));
    mockedExecFileSync.mockReturnValue("Fri Aug  8 11:00:00 2026\n");
  });

  afterAll(() => {
    kill.mockRestore();
  });

  it("classifies matching live process-start evidence as live", () => {
    expect(classifyProcessIdentity({ pid: 123, startToken: "42" }, "linux")).toBe("live");
  });

  it("classifies a token mismatch as dead to prevent PID-reuse takeover", () => {
    expect(classifyProcessIdentity({ pid: 123, startToken: "41" }, "linux")).toBe("dead");
  });

  it("classifies ESRCH as dead", () => {
    kill.mockImplementation(() => {
      const error = Object.assign(new Error("missing process"), { code: "ESRCH" });
      throw error;
    });

    expect(classifyProcessIdentity({ pid: 123, startToken: "42" }, "linux")).toBe("dead");
  });

  it("classifies non-ESRCH signal failures as unknown", () => {
    kill.mockImplementation(() => {
      const error = Object.assign(new Error("permission denied"), { code: "EPERM" });
      throw error;
    });

    expect(classifyProcessIdentity({ pid: 123, startToken: "42" }, "linux")).toBe("unknown");
  });

  it("classifies unreadable process-start evidence as unknown", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("proc unavailable");
    });

    expect(classifyProcessIdentity({ pid: 123, startToken: "42" }, "linux")).toBe("unknown");
  });

  it("degrades an unavailable native probe to stable current-process evidence", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("proc unavailable");
    });
    const first = readProcessStartToken(process.pid, "linux");
    const second = readProcessStartToken(process.pid, "linux");
    expect(first).toMatch(/^fallback:\d+$/);
    expect(second).toBe(first);
  });

  it("does not reclaim a live owner when native and fallback probes alternate", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("proc unavailable");
    });
    const fallback = readProcessStartToken(process.pid, "linux");
    expect(fallback).toBeDefined();

    mockedReadFileSync.mockReturnValue(statWithStartToken("42"));
    expect(classifyProcessIdentity({ pid: process.pid, startToken: fallback! }, "linux")).toBe("unknown");

    mockedReadFileSync.mockImplementation(() => {
      throw new Error("proc unavailable");
    });
    expect(classifyProcessIdentity({ pid: process.pid, startToken: "42" }, "linux")).toBe("unknown");
  });

  it("uses absolute native probe paths instead of the ambient executable search path", () => {
    expect(readProcessStartToken(123, "darwin")).toMatch(/^\d+$/);
    expect(mockedExecFileSync).toHaveBeenLastCalledWith("/bin/ps", expect.any(Array), expect.any(Object));

    mockedExecFileSync.mockReturnValue("638902764000000000\n");
    expect(readProcessStartToken(123, "win32")).toBe("638902764000000000");
    expect(mockedExecFileSync.mock.calls.at(-1)?.[0]).toMatch(/^[A-Za-z]:\\.*\\powershell\.exe$/i);
  });

  it("reads stable start evidence for the current process on macOS", () => {
    if (process.platform !== "darwin") return;
    const first = readProcessStartToken(process.pid);
    const second = readProcessStartToken(process.pid);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });
});
