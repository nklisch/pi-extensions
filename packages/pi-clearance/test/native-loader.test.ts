import { afterEach, describe, expect, it } from "vitest";

import {
  __resetNativeEngineForTests,
  loadNativeEngine,
  requireNativeEngine,
} from "../src/native/loader.ts";

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ARCH = process.arch;

function setPlatform(platform: string, arch: string): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  Object.defineProperty(process, "arch", { configurable: true, value: arch });
}

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM, ORIGINAL_ARCH);
  __resetNativeEngineForTests();
});

describe("native engine loader fail-closed behavior", () => {
  it("reports not-ok on an unsupported platform instead of arming", () => {
    setPlatform("freebsd", "x64");
    __resetNativeEngineForTests();

    const status = loadNativeEngine();

    expect(status.ok).toBe(false);
    if (!status.ok) {
      expect(status.reason).toContain("unsupported native platform");
    }
  });

  it("requireNativeEngine throws an actionable refusal when no engine arms", () => {
    setPlatform("freebsd", "x64");
    __resetNativeEngineForTests();

    expect(() => requireNativeEngine()).toThrowError(
      /refused to arm.*unsupported native platform/,
    );
  });

  it("memoizes the failure rather than retrying mid-session", () => {
    setPlatform("freebsd", "x64");
    __resetNativeEngineForTests();

    const first = loadNativeEngine();
    setPlatform(ORIGINAL_PLATFORM, ORIGINAL_ARCH);
    const second = loadNativeEngine();

    expect(first.ok).toBe(false);
    expect(second).toBe(first);
  });

  it("loads the real artifact on the supported host platform", () => {
    __resetNativeEngineForTests();

    const status = loadNativeEngine();

    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.health.version).toBeTruthy();
    }
  });
});
