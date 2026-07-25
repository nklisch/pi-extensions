import { describe, expect, it, vi } from "vitest";
import { createCompatibilityService } from "../../src/application/compatibility-service.js";
import type { RuntimeCapabilityProbe } from "../../src/application/ports/runtime-capability-probe.js";
import { flattenComponents } from "../../src/domain/components.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import { RuntimeCapabilitySnapshotSchema } from "../../src/domain/compatibility-policy.js";
import { BoundaryError } from "../../src/domain/errors.js";
import { capabilities, inspectNormalizedBundle, marketplacePolicyForFixture } from "../fixtures/compatibility/common.js";
import { configurationIngestionFixture, marketplacePolicyIngestionFixtures } from "../fixtures/compatibility/configuration-marketplace.js";
import { foreignIngestionFixture } from "../fixtures/compatibility/foreign.js";
import { hookIngestionFixtures } from "../fixtures/compatibility/hooks.js";
import { mcpIngestionFixtures } from "../fixtures/compatibility/mcp.js";
import { skillIngestionFixtures } from "../fixtures/compatibility/skills.js";

const mixedManifest = {
  ...foreignIngestionFixture,
  userConfig: configurationIngestionFixture.userConfig,
  category: "compatibility",
  tags: ["fixture", "contract"],
};

const mixedSpec = {
  manifest: mixedManifest,
  skillMarkdown: skillIngestionFixtures.presentation.skillMarkdown,
  skillPresentation: skillIngestionFixtures.presentation.skillPresentation,
  hooks: hookIngestionFixtures.supported.hooks,
  mcpServers: {
    ...mcpIngestionFixtures.stdio,
    ...mcpIngestionFixtures.streamableHttp,
    featureful: mcpIngestionFixtures.features.featureful,
  },
  marketplacePolicy: marketplacePolicyIngestionFixtures[2],
} as const;

async function mixedBundle() {
  return inspectNormalizedBundle(mixedSpec);
}

function serviceFor(snapshot: ReturnType<typeof capabilities>): {
  service: ReturnType<typeof createCompatibilityService>;
  probe: RuntimeCapabilityProbe & { snapshot: ReturnType<typeof vi.fn> };
} {
  const probe = { snapshot: vi.fn(async () => snapshot) };
  return { service: createCompatibilityService(probe), probe };
}

describe("compatibility reporting integration", () => {
  it("assesses a skills bundle produced by the real inspection readers", async () => {
    const plugin = await inspectNormalizedBundle(skillIngestionFixtures.presentation);
    expect(plugin.components.skills).toHaveLength(1);
    expect(plugin.components.skills[0]?.metadata.map((item) => item.key)).toEqual([
      "agent-skills.compatibility",
      "agent-skills.description",
      "agent-skills.disable-model-invocation",
      "agent-skills.license",
      "agent-skills.metadata",
      "agent-skills.allowed-tools",
      "codex.agents.interface",
      "codex.agents.policy",
    ].sort());

    const { service, probe } = serviceFor(capabilities());
    const report = await service.assess({ plugin }, new AbortController().signal);
    expect(probe.snapshot).toHaveBeenCalledTimes(1);
    expect(report.components).toHaveLength(1);
    expect(report.components[0]?.verdict).toEqual({ kind: "supported" });
    expect(report.requirements.map((item) => item.requirement.capability)).toEqual(["pi.skill.allowed-tools"]);
    expect(report.components.some((component) => component.diagnostics.some((item) =>
      item.details && JSON.stringify(item.details).includes("skill.presentation")))).toBe(true);
  });

  it("keeps MCP transport fields coherent through real ingestion and redacts HTTP credentials", async () => {
    const validPlugin = await inspectNormalizedBundle({
      mcpServers: {
        local: {
          command: "node",
          args: ["stdio-server.js"],
          env: { TOKEN: "${CANARY_STDIO_ENV}" },
          cwd: "/CANARY_STDIO_PATH",
        },
        remote: {
          type: "http",
          url: "https://example.invalid/mcp",
          headers: { "X-Trace": "CANARY_HEADER_VALUE" },
          auth: { type: "bearer", env: "CANARY_BEARER_ENV" },
        },
      },
    });
    const validReport = await serviceFor(capabilities()).service.assess(
      { plugin: validPlugin },
      new AbortController().signal,
    );
    expect(validReport.components.map((assessment) => assessment.verdict.kind)).toEqual([
      "supported",
      "supported",
    ]);
    expect(validReport.requirements.map((assessment) => assessment.requirement.capability)).toEqual([
      "pi.mcp.runtime",
      "pi.mcp.transport.streamable-http",
      "pi.mcp.runtime",
      "pi.mcp.transport.stdio",
    ]);
    expect(validReport.activatable).toBe(true);
    expect(JSON.stringify(validReport)).not.toContain("CANARY_HEADER_VALUE");
    expect(JSON.stringify(validReport)).not.toContain("CANARY_BEARER_ENV");

    const invalidPlugin = await inspectNormalizedBundle({
      mcpServers: {
        local: {
          transport: "stdio",
          command: "node",
          url: "https://example.invalid/mcp",
          headers: { "X-Trace": "CANARY_HEADER_VALUE" },
          auth: { type: "bearer", env: "CANARY_BEARER_ENV" },
          oauth: { grantType: "authorization-code", clientId: "CANARY_CLIENT" },
        },
      },
    });
    const invalidReport = await serviceFor(capabilities()).service.assess(
      { plugin: invalidPlugin },
      new AbortController().signal,
    );
    expect(invalidReport.components).toHaveLength(1);
    expect(invalidReport.components[0]?.verdict.kind).toBe("metadata-only");
    expect(invalidReport.activatable).toBe(true);
    expect(invalidReport.requirements).toEqual([]);
    expect(invalidReport.components[0]?.diagnostics.map((diagnostic) => diagnostic.location?.pointer)).toEqual([
      "/local/auth",
      "/local/headers",
      "/local/oauth",
      "/local/url",
    ]);
    const serialized = JSON.stringify(invalidReport);
    expect(serialized).not.toContain("CANARY_HEADER_VALUE");
    expect(serialized).not.toContain("CANARY_BEARER_ENV");
    expect(serialized).not.toContain("CANARY_CLIENT");
  });

  it("reports the complete mixed normalized bundle with degraded-component activation", async () => {
    const plugin = await mixedBundle();
    const { service } = serviceFor(capabilities({}, {
      "pi.mcp.runtime": "CANARY_RUNTIME_PATH 2026-07-12 native error",
      "pi.hooks.command": "CANARY_ENV_VALUE",
    }));
    const marketplacePolicy = marketplacePolicyForFixture(mixedSpec);
    const report = await service.assess({
      plugin,
      ...(marketplacePolicy === undefined ? {} : { marketplacePolicy }),
    }, new AbortController().signal);
    const flattened = flattenComponents(plugin.components);

    expect(report.components).toHaveLength(flattened.length);
    expect(new Set(report.components.map((assessment) => assessment.componentId))).toEqual(
      new Set(flattened.map((component) => component.id)),
    );
    expect(report.components.some((assessment) => assessment.verdict.kind === "metadata-only")).toBe(true);
    expect(report.activatable).toBe(true);
    expect(report.components.find((assessment) => assessment.componentId.includes(":foreign:"))).toBeDefined();
    expect(report.components.some((assessment) => assessment.verdict.kind === "supported")).toBe(true);
    expect(report.requirements.some((item) => item.requirement.capability === "pi.subagents.lifecycle-interception")).toBe(true);
    expect(report.diagnostics.some((item) => item.location?.pointer === "/userConfig/API_TOKEN")).toBe(true);
    expect(report.diagnostics.some((item) => item.location?.path === ".claude-plugin/marketplace.json")).toBe(true);
    for (const requirement of report.requirements) {
      expect(requirement.requirement.provenance.length).toBeGreaterThan(0);
      for (const provenance of requirement.requirement.provenance) {
        expect(provenance.location.host).toBe("claude");
        expect(provenance.location.path.length).toBeGreaterThan(0);
        expect(provenance.location.pointer).toMatch(/^\//u);
      }
    }
    const foreignSourceLocations = report.components
      .filter((assessment) => assessment.componentId.includes(":foreign:"))
      .flatMap((assessment) => assessment.diagnostics.flatMap((diagnostic) => {
        const details = diagnostic.details;
        if (details === null || typeof details !== "object" || Array.isArray(details)) return [];
        const locations = (details as Record<string, unknown>).sourceLocations;
        return Array.isArray(locations) ? locations : [];
      }));
    expect(foreignSourceLocations.some((location) =>
      location !== null && typeof location === "object" &&
      (location as Record<string, unknown>).pointer === "/agents/0")).toBe(true);

    const serialized = JSON.stringify(report);
    for (const canary of [
      "CANARY_ENV_VALUE",
      "CANARY_HEADER_VALUE",
      "CANARY_RUNTIME_PATH",
      "CANARY_FOREIGN_VALUE",
      "CANARY_NATIVE_COMMAND",
      "CANARY_DEFAULT_PATH",
      "CANARY_AUTH_POLICY",
      "2026-07-12",
      "native error",
    ]) {
      expect(serialized, `report leaked ${canary}`).not.toContain(canary);
    }
    expect(report.requirements.every((item) => item.requirement.provenance.every((provenance) =>
      !Object.prototype.hasOwnProperty.call(provenance, "declaration")))).toBe(true);
    expect(report.diagnostics.every((diagnostic) =>
      !JSON.stringify(diagnostic).includes("headers") || JSON.stringify(diagnostic).includes("sourceLocations"))).toBe(true);
  });

  it("keeps available and unavailable capabilities separate from component verdicts", async () => {
    const plugin = await inspectNormalizedBundle({
      hooks: hookIngestionFixtures.supported.hooks,
      mcpServers: {
        ...mcpIngestionFixtures.features,
      },
    });
    const available = await serviceFor(capabilities()).service.assess({ plugin }, new AbortController().signal);
    const unavailable = await serviceFor(capabilities({
      "pi.subagents.lifecycle-interception": "unavailable",
      "pi.mcp.sampling": "unavailable",
    })).service.assess({ plugin }, new AbortController().signal);

    expect(unavailable.components.map((item) => [item.componentId, item.verdict])).toEqual(
      available.components.map((item) => [item.componentId, item.verdict]),
    );
    expect(unavailable.requirements.filter((item) => item.status === "unavailable").map((item) => item.requirement.capability))
      .toEqual(expect.arrayContaining(["pi.subagents.lifecycle-interception", "pi.mcp.sampling"]));
    expect(unavailable.activatable).toBe(false);
    expect(available.activatable).toBe(true);

    const ordinaryPlugin = await inspectNormalizedBundle({
      hooks: {
        hooks: Object.fromEntries(Object.entries(hookIngestionFixtures.supported.hooks.hooks)
          .filter(([event]) => event !== "SubagentStart" && event !== "SubagentStop")),
      },
    });
    const ordinaryUnavailable = await serviceFor(capabilities({
      "pi.subagents.lifecycle-interception": "unavailable",
    })).service.assess({ plugin: ordinaryPlugin }, new AbortController().signal);
    expect(ordinaryUnavailable.requirements.some((item) =>
      item.requirement.capability === "pi.subagents.lifecycle-interception")).toBe(false);
    expect(ordinaryUnavailable.activatable).toBe(true);

    const irrelevant = await serviceFor(capabilities({ "platform.shell.powershell": "unavailable" })).service
      .assess({ plugin }, new AbortController().signal);
    expect(irrelevant.requirements.some((item) => item.requirement.capability === "platform.shell.powershell")).toBe(false);
    expect(irrelevant.activatable).toBe(true);
  });

  it("degrades unknown hook and MCP declarations while preserving one assessment each", async () => {
    const plugin = await inspectNormalizedBundle({
      hooks: hookIngestionFixtures.unknowns.hooks,
      mcpServers: mcpIngestionFixtures.unknown,
    });
    const report = await serviceFor(capabilities()).service.assess({ plugin }, new AbortController().signal);
    expect(report.components).toHaveLength(4);
    expect(report.components.every((item) => item.verdict.kind === "metadata-only")).toBe(true);
    expect(report.components.some((component) => component.diagnostics.some((item) => item.code === "UNSUPPORTED_DECLARATION"))).toBe(true);
    expect(JSON.stringify(report)).not.toContain("CANARY_UNKNOWN");
  });

  it("is deterministic across normalized input and capability-map insertion order", async () => {
    const first = await mixedBundle();
    const second = await inspectNormalizedBundle({
      marketplacePolicy: marketplacePolicyIngestionFixtures[2],
      mcpServers: {
        featureful: mcpIngestionFixtures.features.featureful,
        ...mcpIngestionFixtures.streamableHttp,
        ...mcpIngestionFixtures.stdio,
      },
      hooks: hookIngestionFixtures.supported.hooks,
      skillPresentation: skillIngestionFixtures.presentation.skillPresentation,
      skillMarkdown: skillIngestionFixtures.presentation.skillMarkdown,
      manifest: mixedManifest,
    });
    const marketplacePolicy = marketplacePolicyForFixture(mixedSpec);
    const firstReport = evaluateCompatibility({
      plugin: first,
      capabilities: capabilities(),
      ...(marketplacePolicy === undefined ? {} : { marketplacePolicy }),
    });
    const complete = capabilities();
    const reversedCapabilities = Object.fromEntries(Object.entries(complete.capabilities).reverse());
    const secondReport = evaluateCompatibility({
      plugin: second,
      capabilities: RuntimeCapabilitySnapshotSchema.parse({
        capabilities: reversedCapabilities,
        capturedBy: "compatibility-fixture",
      }),
      ...(marketplacePolicy === undefined ? {} : { marketplacePolicy }),
    });
    expect(JSON.stringify(firstReport)).toBe(JSON.stringify(secondReport));
  });

  it("keeps adapter and caller errors outside successful compatibility results", async () => {
    const plugin = await inspectNormalizedBundle(skillIngestionFixtures.minimal);
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    const preAbortProbe = { snapshot: vi.fn(async () => capabilities()) };
    await expect(createCompatibilityService(preAbortProbe).assess({ plugin }, controller.signal)).rejects.toBe(reason);
    expect(preAbortProbe.snapshot).not.toHaveBeenCalled();

    const cause = new Error("native probe failure");
    const failingProbe = { snapshot: vi.fn(async () => { throw cause; }) };
    const error = await createCompatibilityService(failingProbe).assess({ plugin }, new AbortController().signal)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(BoundaryError);
    expect(error).toMatchObject({ code: "ADAPTER_FAILED", operation: "probeRuntimeCapabilities" });
    expect((error as BoundaryError).cause).toBe(cause);
    expect(JSON.stringify(error)).not.toContain("components");
  });
});
