import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetNativeEngineForTests,
  loadNativeEngine,
  nativePlatformTriple,
  requireNativeEngine,
} from "../src/native/loader.ts";

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ARCH = process.arch;

/**
 * Resolve the napi-rs platform-package suffix for the host. Mirrors
 * `nativePlatformTriple()` only so the test knows whether the real host has
 * a prebuild artifact available to load; the dispatch itself is asserted
 * directly against the production function in the test below.
 */
function hostTriple(platform: string, arch: string): string | undefined {
  return nativePlatformTripleWith(platform, arch);
}

/** Test-only override helper around `nativePlatformTriple`. */
function nativePlatformTripleWith(platform: string, arch: string): string | undefined {
  setPlatform(platform, arch);
  try {
    return nativePlatformTriple();
  } finally {
    setPlatform(ORIGINAL_PLATFORM, ORIGINAL_ARCH);
  }
}

const HOST_TRIPLE = hostTriple(ORIGINAL_PLATFORM, ORIGINAL_ARCH);
const HAS_HOST_ARTIFACT =
  HOST_TRIPLE !== undefined &&
  existsSync(
    fileURLToPath(
      new URL(`../native/clearance-core.${HOST_TRIPLE}.node`, import.meta.url),
    ),
  );

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
  it("maps every common dev platform to a napi-rs suffix via the production dispatch", () => {
    // Regression for the platform-coverage gap: each common platform must
    // resolve to a triple via the production `nativePlatformTriple`, not a
    // test-local copy. Asserting the production function directly catches a
    // regression in either the dispatch or the suffix string.
    expect(nativePlatformTripleWith("linux", "x64")).toBe("linux-x64-gnu");
    expect(nativePlatformTripleWith("linux", "arm64")).toBe("linux-arm64-gnu");
    expect(nativePlatformTripleWith("darwin", "x64")).toBe("darwin-x64");
    expect(nativePlatformTripleWith("darwin", "arm64")).toBe("darwin-arm64");
    expect(nativePlatformTripleWith("win32", "x64")).toBe("win32-x64-msvc");
    expect(nativePlatformTripleWith("win32", "arm64")).toBe("win32-arm64-msvc");
    expect(nativePlatformTripleWith("freebsd", "x64")).toBeUndefined();
    expect(nativePlatformTripleWith("aix", "ppc")).toBeUndefined();
  });

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

  it.skipIf(!HAS_HOST_ARTIFACT)(
    "loads the real artifact on the supported host platform",
    () => {
      __resetNativeEngineForTests();

      const status = loadNativeEngine();

      expect(status.ok).toBe(true);
      if (status.ok) {
        expect(status.health.version).toBeTruthy();
      }
    },
  );
});
