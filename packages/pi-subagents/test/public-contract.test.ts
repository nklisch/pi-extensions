import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import { PARENT_ONLY_TOOL_NAMES, PARENT_ONLY_TOOL_SET } from "#src/tools/parent-tool-registry";

describe("packaged public declaration contract", () => {
  it("publishes the root declaration through the package export", () => {
    expect(packageJson.exports["."]).toMatchObject({ types: "./dist/public.d.ts", default: "./src/service/service.ts" });
  });

  it("publishes settings declarations through the settings export", () => {
    expect(packageJson.exports["./settings"]).toEqual({ types: "./dist/settings.d.ts", default: "./src/layered-settings.ts" });
  });

  it("keeps the built root declaration self-contained and public", async () => {
    const declaration = await readFile(resolve(process.cwd(), "dist/public.d.ts"), "utf8");
    expect(declaration).not.toContain("#src/");
    for (const symbol of ["getSubagentsService", "SubagentsService", "WorkspaceProvider", "SubagentLifecycleInterceptor", "MAX_LIFECYCLE_CONTINUATION_ROUNDS"]) expect(declaration).toContain(symbol);
  });

  it("keeps the built settings declaration self-contained", async () => {
    const declaration = await readFile(resolve(process.cwd(), "dist/settings.d.ts"), "utf8");
    expect(declaration).not.toContain("#src/");
    expect(declaration).toContain("loadLayeredSettings");
    expect(declaration).toContain("LayeredSettingsSource");
  });

  it("keeps the parent-only registry exact and set-backed", () => {
    expect(PARENT_ONLY_TOOL_NAMES).toEqual(["subagent", "resume_subagent", "stop_subagent", "steer_subagent", "list_subagents", "get_subagent_result", "query_subagent_session"]);
    expect([...PARENT_ONLY_TOOL_SET]).toEqual([...PARENT_ONLY_TOOL_NAMES]);
    expect(PARENT_ONLY_TOOL_NAMES.every((name) => PARENT_ONLY_TOOL_SET.has(name))).toBe(true);
  });
});
