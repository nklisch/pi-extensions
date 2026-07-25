import { describe, expect, it } from "vitest";
import { createNativeControlParser } from "../../src/application/native-control-parser.js";

const parser = createNativeControlParser();

describe("native control help and completion", () => {
  it("derives exact metadata from the registry", () => {
    const help = parser.help(["marketplace", "refresh"]);
    expect(help.grammarVersion).toBe("plugin-control/v1");
    expect(help.commands).toMatchObject([{ id: "marketplace.refresh", path: ["marketplace", "refresh"], aliases: [{ path: ["marketplace", "update"] }] }]);
    expect(parser.parseArgv(["help", "marketplace", "refresh"])).toEqual({ kind: "help", help });
  });

  it("completes only static safe metadata and supplied safe candidates", () => {
    const root = parser.complete({ text: "mar", dynamic: [] });
    expect(root.candidates.map((candidate) => candidate.value)).toContain("marketplace add");
    const primary = parser.complete({ text: "", dynamic: [] }).candidates.map((candidate) => candidate.value);
    expect(primary).toContain("add");
    expect(primary).toContain("remove");
    expect(primary).toContain("doctor");
    expect(primary).not.toContain("install open");
    expect(primary).not.toContain("operation status");
    expect(parser.help().commands.map((command) => command.id)).not.toContain("install.open");
    const plugins = parser.complete({ text: "show d", dynamic: [{ category: "plugin", value: "demo@market", safe: { text: "demo@market", escaped: false, truncated: false } }] });
    expect(plugins.candidates).toMatchObject([{ value: "demo@market", kind: "dynamic" }]);
    expect(JSON.stringify(plugins)).not.toContain("token");
  });

  it("keeps legacy and protocol paths parseable without advertising them", () => {
    expect(parser.parseArgv(["add", "demo@market", "--scope", "user"])).toMatchObject({ kind: "parsed", command: { command: "install.run" } });
    expect(parser.parseArgv(["install", "demo@market", "--scope", "user"])).toMatchObject({ kind: "parsed", command: { command: "install.run" } });
    expect(parser.parseArgv(["remove", "demo@market", "--scope", "user", "--keep-data"])).toMatchObject({ kind: "parsed", command: { command: "lifecycle.uninstall" } });
    expect(parser.parseArgv(["doctor"])).toMatchObject({ kind: "parsed", command: { command: "inspection.diagnose" } });
    expect(parser.help(["install", "open"]).commands).toMatchObject([{ id: "install.open" }]);
  });

  it("reports incomplete quotes without guessing", () => {
    expect(parser.complete({ text: "browse 'par", dynamic: [] })).toMatchObject({ incomplete: true });
  });
});
