import { describe, expect, it } from "vitest";
import { createNativeControlParser } from "../../src/application/native-control-parser.js";

const parser = createNativeControlParser();

describe("native control parser", () => {
  it("makes argv and quoted text equivalent", () => {
    const argv = parser.parseArgv(["--output", "json", "browse", "alpha beta", "--scope=all-current", "--limit", "20"]);
    const text = parser.parseText("--output json browse 'alpha beta' --scope=all-current --limit 20");
    expect(text).toEqual(argv);
    expect(argv).toMatchObject({ kind: "parsed", command: { command: "browse", request: { query: "alpha beta", limit: 20 }, invocation: { output: "json" } } });
  });

  it("defaults marketplace shorthand to the global GitHub registry", () => {
    expect(parser.parseArgv(["marketplace", "add", "nklisch/skills"])).toMatchObject({
      kind: "parsed",
      command: { command: "marketplace.add", request: { source: { kind: "github", repository: "nklisch/skills" } } },
    });
    expect(parser.parseArgv(["marketplace", "add", "https://example.com/catalog.git", "--source-kind", "git"])).toMatchObject({
      kind: "parsed",
      command: { command: "marketplace.add", request: { source: { kind: "git", url: "https://example.com/catalog.git" } } },
    });
    expect(parser.parseArgv(["marketplace", "add", "nklisch/skills", "--scope", "user"])).toMatchObject({
      kind: "invalid", diagnostics: [{ code: "CONTROL_OPTION_UNKNOWN" }],
    });
  });

  it("canonicalizes stable aliases and never fuzzy executes", () => {
    expect(parser.parseArgv(["inspect", "demo@market", "--scope", "user"])).toMatchObject({ kind: "parsed", command: { command: "inspection.show" }, warnings: [] });
    expect(parser.parseArgv(["inspec", "demo@market", "--scope", "user"])).toMatchObject({ kind: "invalid", diagnostics: [{ code: "CONTROL_COMMAND_UNKNOWN" }] });
    expect(parser.parseArgv(["show", "demo@market", "--scope", "user", "--snap", "x"])).toMatchObject({ kind: "invalid", diagnostics: [{ code: "CONTROL_OPTION_UNKNOWN" }] });
  });

  it("rejects duplicate/conflicting/missing and hostile inputs", () => {
    expect(parser.parseArgv(["list", "--limit", "1", "--limit", "2"])).toMatchObject({ kind: "invalid", diagnostics: [{ code: "CONTROL_OPTION_DUPLICATE" }] });
    expect(parser.parseArgv(["uninstall", "demo@market", "--scope", "user", "--yes"])).toMatchObject({ kind: "invalid", diagnostics: [{ code: "CONTROL_RETENTION_REQUIRED" }] });
    expect(parser.parseArgv(["uninstall", "demo@market", "--scope", "user", "--yes", "--keep-data", "--delete-data"])).toMatchObject({ kind: "invalid", diagnostics: [{ code: "CONTROL_OPTION_CONFLICT" }] });
    expect(parser.parseArgv(["browse", "x\u202e"])).toMatchObject({ kind: "invalid", diagnostics: [{ code: "CONTROL_ARGV_UNSAFE" }] });
  });

  it("rejects unknown help paths explicitly", () => {
    expect(parser.parseArgv(["help", "does-not-exist"])).toMatchObject({ kind: "invalid", diagnostics: [{ code: "CONTROL_HELP_PATH_UNKNOWN" }] });
  });

  it("keeps input channels global, exclusive, and out of requests", () => {
    const parsed = parser.parseArgv(["--non-interactive", "--input-file", "/private/input", "install", "demo@market", "--scope", "user"]);
    expect(parsed).toMatchObject({ kind: "parsed", command: { request: { plugin: "demo@market" }, invocation: { nonInteractive: true, input: { kind: "file-json", locator: "/private/input" } } } });
    expect(parser.parseArgv(["--input-stdin", "--input-env-prefix", "SAFE", "status"])).toMatchObject({ kind: "invalid", diagnostics: [{ code: "CONTROL_INPUT_CHANNEL_CONFLICT" }] });
  });
});
