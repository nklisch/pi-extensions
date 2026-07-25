import { afterEach, describe, expect, test } from "bun:test";
import fffCompatSearch from "./fff-compat-search";

type ToolDef = { name: string; description?: string };
type CommandDef = { description?: string };

function load() {
  const tools: string[] = [];
  const commands: string[] = [];
  const pi = {
    registerTool: (tool: ToolDef) => {
      tools.push(tool.name);
    },
    registerCommand: (name: string, _options: CommandDef) => {
      commands.push(name);
    },
    on: () => {},
  };
  fffCompatSearch(pi as never);
  return { tools, commands };
}

const ENV_VARS = ["PI_FFF_COMPAT_OVERRIDE", "PI_FFF_COMPAT_DISABLE"] as const;
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved.has(name)) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  saved.clear();
});

function setEnv(name: (typeof ENV_VARS)[number], value: string | undefined) {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("pi-fff-compat registration", () => {
  test("default mode registers additive fast_find/fast_grep tools", () => {
    setEnv("PI_FFF_COMPAT_OVERRIDE", undefined);
    setEnv("PI_FFF_COMPAT_DISABLE", undefined);
    const { tools } = load();
    expect(tools).toContain("fast_find");
    expect(tools).toContain("fast_grep");
    expect(tools).not.toContain("find");
    expect(tools).not.toContain("grep");
  });

  test("override mode registers as find/grep", () => {
    setEnv("PI_FFF_COMPAT_OVERRIDE", "1");
    const { tools } = load();
    expect(tools).toContain("find");
    expect(tools).toContain("grep");
    expect(tools).not.toContain("fast_find");
  });

  test("disable env registers nothing", () => {
    setEnv("PI_FFF_COMPAT_DISABLE", "1");
    const { tools, commands } = load();
    expect(tools).toHaveLength(0);
    expect(commands).toHaveLength(0);
  });

  test("status and rescan commands are always registered", () => {
    setEnv("PI_FFF_COMPAT_OVERRIDE", undefined);
    setEnv("PI_FFF_COMPAT_DISABLE", undefined);
    const { commands } = load();
    expect(commands).toContain("fff-compat");
    expect(commands).toContain("fff-compat-rescan");
  });
});
