import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveConfigPaths,
  resolveUserConfigRoot,
} from "../../src/config/paths.ts";

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  process.env = { ...ORIGINAL_ENV };
});

describe("config paths", () => {
  it("does not expose reviewer consent storage", () => {
    expect("reviewerConsentFile" in resolveConfigPaths("/repo")).toBe(false);
  });

  it("targets the platform-specific user config root", () => {
    const home = "/tmp/pi-clearance-home";
    process.env = {
      ...ORIGINAL_ENV,
      HOME: home,
      XDG_CONFIG_HOME: "/tmp/pi-clearance-xdg",
      LOCALAPPDATA: "/tmp/pi-clearance-local",
    };

    setPlatform("linux");
    expect(resolveUserConfigRoot()).toBe(
      "/tmp/pi-clearance-xdg/pi/pi-clearance",
    );

    setPlatform("darwin");
    expect(resolveUserConfigRoot()).toBe(
      `${home}/Library/Application Support/pi/pi-clearance`,
    );

    setPlatform("win32");
    expect(resolveUserConfigRoot()).toBe(
      "/tmp/pi-clearance-local/pi/pi-clearance",
    );
  });

  it("treats empty home and config environment variables as absent", () => {
    const userProfile = "/tmp/pi-clearance-user-profile";
    process.env = {
      ...ORIGINAL_ENV,
      HOME: "",
      USERPROFILE: userProfile,
      XDG_CONFIG_HOME: "",
      LOCALAPPDATA: "",
    };

    setPlatform("linux");
    expect(resolveUserConfigRoot()).toBe(
      path.join(userProfile, ".config", "pi", "pi-clearance"),
    );

    setPlatform("darwin");
    expect(resolveUserConfigRoot()).toBe(
      path.join(
        userProfile,
        "Library",
        "Application Support",
        "pi",
        "pi-clearance",
      ),
    );

    setPlatform("win32");
    expect(resolveUserConfigRoot()).toBe(
      path.join(userProfile, "AppData", "Local", "pi", "pi-clearance"),
    );

    process.env.USERPROFILE = "";
    setPlatform("linux");
    expect(resolveUserConfigRoot()).toBe(
      path.join(homedir(), ".config", "pi", "pi-clearance"),
    );
  });
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}
