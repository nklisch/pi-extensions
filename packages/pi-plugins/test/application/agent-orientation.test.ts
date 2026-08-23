import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_ORIENTATION_DESCRIPTION_LENGTH,
  assembleAgentOrientation,
  type OrientationPlugin,
} from "../../src/application/agent-orientation.js";
import type { ScopeReference } from "../../src/domain/state/scope.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const user: ScopeReference = { kind: "user" };

function plugin(overrides: Partial<OrientationPlugin> = {}): OrientationPlugin {
  return {
    scope: user,
    plugin: "workbench@workbench",
    marketplace: "workbench",
    version: "0.10.0",
    revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    activation: "enabled",
    active: true,
    skills: [{ name: "work" , description: "Requirements-first delivery" }],
    hooks: ["SessionStart"],
    mcpServers: [],
    ...overrides,
  };
}

describe("agent orientation content", () => {
  it("assembles agent-only context with versions, origins, counts, and degraded state", () => {
    const content = assembleAgentOrientation({
      packageVersion: "0.3.9",
      briefPath: "/home/user/.pi/agent/plugin-host/generated/projects/demo/agent-brief.md",
      scopeLabel: "user + current project scope",
      plugins: [
        plugin(),
        plugin({ plugin: "disabled@market", marketplace: "market", activation: "disabled", active: false, skills: [], hooks: [], mcpServers: ["server"] }),
      ],
      degraded: [{ plugin: "workbench@workbench", scope: user, code: "MCP_RUNTIME_UNAVAILABLE", explanation: "MCP is unavailable" }],
      sha256,
    });

    expect(content.injectionLines).toHaveLength(3);
    expect(content.injectionLines.join("\n")).toContain("workbench@workbench 0.10.0");
    expect(content.injectionLines.join("\n")).toContain("workbench@workbench 0.10.0 (1 skills, 1 hooks, 0 MCP servers");
    expect(content.injectionLines.join("\n")).toContain("MCP_RUNTIME_UNAVAILABLE");
    expect(content.injectionLines.join("\n")).not.toContain("/plugins");
    expect(content.injectionLines[2]).toBe("Per-plugin component detail: /home/user/.pi/agent/plugin-host/generated/projects/demo/agent-brief.md");
  });

  it("marks the human command section and keeps command tokens inside it", () => {
    const brief = assembleAgentOrientation({
      packageVersion: "0.3.9",
      briefPath: "/brief.md",
      scopeLabel: "user scope",
      plugins: [plugin()],
      degraded: [],
      sha256,
    }).briefMarkdown;
    const marker = "## For the human user — not agent tools";
    const markerIndex = brief.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(brief.slice(0, markerIndex)).not.toContain("/plugins");
    expect(brief.slice(markerIndex)).toContain("/plugins");
  });

  it("omits overlong descriptions deterministically while retaining component counts", () => {
    const longDescription = "x".repeat(MAX_ORIENTATION_DESCRIPTION_LENGTH + 1);
    const brief = assembleAgentOrientation({
      packageVersion: "0.3.9",
      briefPath: "/brief.md",
      scopeLabel: "user scope",
      plugins: [plugin({
        skills: [{ name: "long-skill", description: longDescription }],
        skillCount: 1,
      })],
      degraded: [],
      sha256,
    }).briefMarkdown;
    expect(brief).toContain("components: 1 skills, 1 hooks, 0 MCP servers");
    expect(brief).toContain("skills (1):\n- long-skill");
    expect(brief).not.toContain(longDescription);
  });
});
