import { describe, expect, it } from "vitest";
import { sealedFloor } from "../../src/packs/floor.ts";
import {
  COMMAND_ONLY_EXTENSION_AUDIT_ENTRIES,
  KNOWN_EXTENSION_TOOL_SPECS,
  PI_CONFIG_EXTENSION_PACK_FOLLOW_UP,
  PUBLIC_EXTENSION_PACKAGE_AUDIT,
  piExtensionInspectPack,
  piExtensionNetworkResearchPack,
  piExtensionReviewBoundariesPack,
  piExtensionWorkflowPack,
} from "../../src/packs/pi.extension.inspect.ts";
import { SUPPORTED_PI_TOOL_SPECS } from "../../src/parse/native-tool.ts";
import type {
  PiBuiltinToolOperation,
  ToolShape,
} from "../../src/parse/shape.ts";
import type { PolicyPack } from "../../src/policy/core.ts";
import { decide } from "../../src/policy/core.ts";

function shape(
  toolName: string,
  operation: PiBuiltinToolOperation = "status-read",
  diagnostics: ToolShape["diagnostics"] = [],
): ToolShape {
  return {
    kind: "pi-tool",
    toolName,
    operation,
    rawInput: {},
    pathInputs: [],
    diagnostics,
  };
}

function decideWith(pack: PolicyPack, toolName: string) {
  const operation = KNOWN_EXTENSION_TOOL_SPECS.find(
    (spec) => spec.toolName === toolName,
  )?.operation as PiBuiltinToolOperation | undefined;
  return decide(shape(toolName, operation ?? "status-read"), {
    floor: sealedFloor.rules,
    active: pack.rules,
  });
}

describe("public extension shipped packs", () => {
  it("allows typed status and workspace-read extension tools in the inspect pack", () => {
    expect(decideWith(piExtensionInspectPack, "jobs")).toMatchObject({
      effect: "allow",
      provenance: { packId: "pi.extension.inspect" },
    });
    expect(decideWith(piExtensionInspectPack, "multi_grep")).toMatchObject({
      effect: "allow",
      provenance: { packId: "pi.extension.inspect" },
    });
  });

  it("allows bounded session/workflow mutations only in the workflow pack", () => {
    expect(decideWith(piExtensionWorkflowPack, "todo")).toMatchObject({
      effect: "allow",
      provenance: { packId: "pi.extension.workflow" },
    });
    expect(decideWith(piExtensionWorkflowPack, "create_goal")).toMatchObject({
      effect: "allow",
      provenance: { packId: "pi.extension.workflow" },
    });
  });

  it("keeps provider/network reads in their explicit permissive pack", () => {
    expect(
      decideWith(piExtensionNetworkResearchPack, "zai_web_search"),
    ).toMatchObject({
      effect: "allow",
      provenance: { packId: "pi.extension.network-research" },
    });
    expect(
      decideWith(piExtensionNetworkResearchPack, "umans_vision"),
    ).toMatchObject({
      effect: "allow",
      provenance: { packId: "pi.extension.network-research" },
    });
  });

  it("allows agent dispatch as a shipped deterministic decision", () => {
    for (const toolName of ["subagent", "steer_subagent"] as const) {
      expect(decideWith(piExtensionInspectPack, toolName)).toMatchObject({
        effect: "allow",
        provenance: {
          packId: "pi.extension.inspect",
          ruleId: "pi.extension.inspect:allow-agent-dispatch",
        },
      });
    }
    expect(
      decideWith(piExtensionInspectPack, "list_subagent_models"),
    ).toMatchObject({
      effect: "allow",
      provenance: { packId: "pi.extension.inspect" },
    });
  });

  it("review-gates embedded shell tools", () => {
    expect(
      decideWith(piExtensionReviewBoundariesPack, "background"),
    ).toMatchObject({
      effect: "review",
      provenance: { packId: "pi.extension.review-boundaries" },
    });
    expect(
      decideWith(piExtensionReviewBoundariesPack, "monitor"),
    ).toMatchObject({
      effect: "review",
      provenance: { packId: "pi.extension.review-boundaries" },
    });
  });

  it("fails malformed typed extension inputs closed before allow rules", () => {
    expect(
      decide(
        shape("todo", "mutation", [
          {
            code: "pi-tool:malformed-input",
            severity: "error",
            message: "bad input",
          },
        ]),
        { floor: sealedFloor.rules, active: piExtensionWorkflowPack.rules },
      ),
    ).toMatchObject({ effect: "review", reason: "parse diagnostics present" });
  });
});

describe("public extension audit catalog", () => {
  it("classifies every requested public package surface", () => {
    const packageNames = new Set(
      PUBLIC_EXTENSION_PACKAGE_AUDIT.map((entry) => entry.packageName),
    );

    expect(packageNames).toEqual(
      new Set([
        "@ff-labs/pi-fff",
        "nklisch/skills:background-tasks",
        "@juicesharp/rpiv-todo",
        "@juicesharp/rpiv-ask-user-question",
        "pi-goals",
        "@gotgenes/pi-subagents",
        "nklisch/skills:zai-research",
        "pi-provider-umans",
        "pi-tool-display",
        "pi-catppuccin-tui",
        "pi-model-modes",
        "@narumitw/pi-codex-usage",
      ]),
    );

    expect(COMMAND_ONLY_EXTENSION_AUDIT_ENTRIES).toHaveLength(4);
    expect(
      KNOWN_EXTENSION_TOOL_SPECS.filter(
        (spec) => spec.activation === "review-only",
      ).map((spec) => spec.toolName),
    ).toEqual(["background", "monitor"]);
  });

  it("routes local/private pi-config tools to pi-config-owned follow-up entries", () => {
    expect(PI_CONFIG_EXTENSION_PACK_FOLLOW_UP).toHaveLength(4);
    expect(
      PI_CONFIG_EXTENSION_PACK_FOLLOW_UP.every(
        (entry) =>
          !entry.publicPackage && entry.activation === "pi-config-owned",
      ),
    ).toBe(true);
    expect(
      PI_CONFIG_EXTENSION_PACK_FOLLOW_UP.map((entry) => entry.packageName),
    ).toEqual([
      "../pi-config/pi/extensions/fff-compat-search.ts",
      "../pi-config/pi/extensions/model-list.ts",
      "../pi-config/pi/extensions/context-window-footer",
      "../pi-config/pi/extensions/zz-rtk-rewrite.ts",
    ]);
  });

  it("has analyzers for every public extension tool that core classifies", () => {
    const analyzedToolNames: ReadonlySet<string> = new Set(
      SUPPORTED_PI_TOOL_SPECS.map((spec) => spec.toolName),
    );

    for (const spec of KNOWN_EXTENSION_TOOL_SPECS) {
      expect(
        analyzedToolNames.has(spec.toolName),
        `${spec.toolName} lacks a typed analyzer`,
      ).toBe(true);
    }
  });
});
