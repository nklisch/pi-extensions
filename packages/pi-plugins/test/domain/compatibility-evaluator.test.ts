import { describe, expect, it } from "vitest";
import {
  CompatibilityPolicyRegistry,
  RuntimeCapabilityRegistry,
  RuntimeCapabilitySnapshotSchema,
} from "../../src/domain/compatibility-policy.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import { claim, type Provenance } from "../../src/domain/provenance.js";
import type { NormalizedPlugin } from "../../src/domain/plugin.js";

const manifest: Provenance = {
  location: {
    host: "claude",
    documentKind: "manifest",
    path: ".claude-plugin/plugin.json",
    pointer: "/components",
  },
};

const source = createResolvedPluginSource({
  kind: "git",
  url: "https://example.com/demo.git",
  revision: "a".repeat(40),
}, () => Uint8Array.from({ length: 32 }, (_, index) => index));

function componentId(kind: "skill" | "hook" | "mcp-server" | "foreign", hex: string): string {
  return `component-v1:${kind}:${hex.repeat(64).slice(0, 64)}`;
}

function capabilities(overrides: Record<string, "available" | "unavailable"> = {}) {
  return RuntimeCapabilitySnapshotSchema.parse({
    capabilities: Object.fromEntries(Object.values(RuntimeCapabilityRegistry).map((entry) => [
      entry.id,
      {
        status: overrides[entry.id] ?? "available",
        explanation: `${entry.id} fixture status`,
      },
    ])),
    capturedBy: "unit-test",
  });
}

function plugin(overrides: Record<string, unknown> = {}): NormalizedPlugin {
  return NormalizedPluginSchema.parse({
    identity: {
      key: "demo@community",
      marketplaceName: "community",
      marketplaceEntryName: "demo",
    },
    source,
    configuration: { options: [] },
    components: {
      skills: [{
        kind: "skill",
        id: componentId("skill", "0"),
        name: claim("demo", manifest),
        root: claim("skills/demo", manifest),
        metadata: [{
          key: "agent-skills.allowed-tools",
          claimed: claim("bash", manifest),
        }],
      }],
      hooks: [{
        kind: "hook",
        id: componentId("hook", "1"),
        event: claim("SessionStart", manifest),
        handler: claim({ kind: "shell", command: "./start.sh" }, manifest),
        metadata: [],
      }],
      mcpServers: [{
        kind: "mcp-server",
        id: componentId("mcp-server", "2"),
        nativeKey: claim("search", manifest),
        declaration: claim({ transport: "stdio", command: "search-server" }, manifest),
        metadata: [],
      }],
      foreign: [{
        kind: "foreign",
        id: componentId("foreign", "3"),
        nativeHost: "codex",
        nativeKind: claim("apps", manifest),
        declarationSubkey: "remote",
        declaration: claim({ secret: "do-not-copy" }, manifest),
      }],
    },
    metadata: [],
    ...overrides,
  });
}

describe("pure compatibility evaluator", () => {
  it("assesses every flattened component exactly once and degrades foreign components to metadata only", () => {
    const report = evaluateCompatibility({ plugin: plugin(), capabilities: capabilities() });
    expect(report.components).toHaveLength(4);
    expect(report.components.map((assessment) => assessment.componentId)).toEqual([
      componentId("skill", "0"),
      componentId("hook", "1"),
      componentId("mcp-server", "2"),
      componentId("foreign", "3"),
    ]);
    expect(report.components.find((assessment) => assessment.componentId.includes(":foreign:"))?.verdict.kind).toBe("metadata-only");
    expect(report.activatable).toBe(true);
    expect(report.requirements.map((assessment) => assessment.requirement.capability)).toEqual([
      "pi.skill.allowed-tools",
      "pi.hooks.command",
      "platform.shell.bash",
      "pi.mcp.runtime",
      "pi.mcp.transport.stdio",
    ]);
    expect(JSON.stringify(report)).not.toContain("do-not-copy");
  });

  it("keeps supported verdicts stable when a cited runtime capability is unavailable", () => {
    const report = evaluateCompatibility({
      plugin: plugin({
        components: {
          ...plugin().components,
          foreign: [],
        },
      }),
      capabilities: capabilities({ "pi.hooks.command": "unavailable" }),
    });
    const hook = report.components.find((assessment) => assessment.componentId.includes(":hook:"));
    expect(hook?.verdict).toEqual({ kind: "supported" });
    expect(report.requirements.find((assessment) => assessment.requirement.capability === "pi.hooks.command")?.status).toBe("unavailable");
    expect(report.activatable).toBe(false);
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === "UNSUPPORTED_DECLARATION")).toBe(false);
  });

  it("adds configuration and marketplace diagnostics without synthetic graph nodes", () => {
    const value = plugin({
      configuration: {
        options: [{
          key: "API_TOKEN",
          label: claim("Token", manifest),
          value: { kind: "string" },
          required: true,
          sensitive: true,
          provenance: [manifest],
        }],
      },
    });
    const report = evaluateCompatibility({
      plugin: value,
      capabilities: capabilities(),
      marketplacePolicy: {
        availability: claim("not-available", manifest),
        authentication: claim("oauth", manifest),
        declaration: claim({ token: "do-not-copy" }, manifest),
      },
    });
    expect(report.components).toHaveLength(4);
    expect(report.requirements.some((assessment) => assessment.requirement.capability === "API_TOKEN")).toBe(false);
    expect(report.diagnostics.map((diagnostic) => diagnostic.details)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: CompatibilityPolicyRegistry.configuration.sensitive.id }),
      expect.objectContaining({ ruleId: CompatibilityPolicyRegistry.marketplace.availabilityNotAvailable.id }),
    ]));
    expect(JSON.stringify(report)).not.toContain("do-not-copy");
  });

  it("retains un-runnable MCP declarations as metadata-only with safe, source-located diagnostics", () => {
    const value = plugin({
      components: {
        ...plugin().components,
        mcpServers: [{
          kind: "mcp-server",
          id: componentId("mcp-server", "4"),
          nativeKey: claim("remote", manifest),
          declaration: claim({ transport: "stdio", command: "server", headersHelper: "secret-helper" }, manifest),
          metadata: [],
        }],
        foreign: [],
      },
    });
    const report = evaluateCompatibility({ plugin: value, capabilities: capabilities() });
    const assessment = report.components.find((item) => item.componentId === componentId("mcp-server", "4"));
    expect(assessment?.verdict.kind).toBe("metadata-only");
    expect(assessment?.diagnostics.some((diagnostic) =>
      diagnostic.details !== null && typeof diagnostic.details === "object" &&
      "sourceLocations" in diagnostic.details)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("secret-helper");
  });

  it("degrades literal structured credentials and authorization/bearer ambiguity to metadata only", () => {
    const declarations = [
      { transport: "stdio", command: "server", env: { API_TOKEN: "CANARY_STATIC_ENV" } },
      { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer CANARY_STATIC_HEADER" } },
      { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN}" }, bearerTokenEnv: "TOKEN" },
    ];
    const value = plugin({
      components: {
        skills: [],
        hooks: [],
        mcpServers: declarations.map((declaration, index) => ({
          kind: "mcp-server" as const,
          id: componentId("mcp-server", String(index + 5)),
          nativeKey: claim(`server-${index}`, manifest),
          declaration: claim(declaration, manifest),
          metadata: [],
        })),
        foreign: [],
      },
    });
    const report = evaluateCompatibility({ plugin: value, capabilities: capabilities() });
    expect(report.components.map((item) => item.verdict.kind)).toEqual([
      "metadata-only",
      "metadata-only",
      "metadata-only",
    ]);
    expect(JSON.stringify(report)).not.toMatch(/CANARY_STATIC_(?:ENV|HEADER)/);
  });

  it("reproduces fail-open hook conditions, ambiguous OAuth, and malformed feature flags", () => {
    const arbitraryCondition = evaluateCompatibility({
      plugin: plugin({
        components: {
          skills: [],
          hooks: [{
            kind: "hook",
            id: componentId("hook", "5"),
            event: claim("PreToolUse", manifest),
            handler: claim({ kind: "exec", command: "check", args: [] }, manifest),
            metadata: [{
              key: "claude.hook.if",
              claimed: claim("arbitrary condition syntax", manifest),
            }],
          }],
          mcpServers: [],
          foreign: [],
        },
      }),
      capabilities: capabilities(),
    });
    expect(arbitraryCondition.components[0]?.verdict.kind).toBe("metadata-only");
    expect(arbitraryCondition.components[0]?.diagnostics[0]?.code).toBe("UNSUPPORTED_DECLARATION");
    expect(arbitraryCondition.components[0]?.diagnostics[0]?.location?.pointer).toBe("/components");
    expect(arbitraryCondition.components[0]?.diagnostics[0]?.details).toMatchObject({
      field: "if",
      ruleId: "hook.event.default-deny",
    });

    const ambiguousOAuth = evaluateCompatibility({
      plugin: plugin({
        components: {
          skills: [],
          hooks: [],
          mcpServers: [{
            kind: "mcp-server",
            id: componentId("mcp-server", "6"),
            nativeKey: claim("oauth", manifest),
            declaration: claim({
              transport: "streamable-http",
              url: "https://example.invalid/mcp",
              oauth: { grantType: "authorization-code", flow: "client-credentials" },
            }, manifest),
            metadata: [],
          }],
          foreign: [],
        },
      }),
      capabilities: capabilities(),
    });
    expect(ambiguousOAuth.components[0]?.verdict.kind).toBe("metadata-only");
    expect(ambiguousOAuth.components[0]?.diagnostics[0]?.code).toBe("UNSUPPORTED_DECLARATION");
    expect(ambiguousOAuth.components[0]?.diagnostics[0]?.location?.pointer).toBe("/components/oauth");
    expect(ambiguousOAuth.components[0]?.diagnostics[0]?.details).toMatchObject({
      field: "oauth",
      ruleId: "mcp.default-deny",
    });

    const malformedFeature = evaluateCompatibility({
      plugin: plugin({
        components: {
          skills: [],
          hooks: [],
          mcpServers: [{
            kind: "mcp-server",
            id: componentId("mcp-server", "7"),
            nativeKey: claim("sampling", manifest),
            declaration: claim({
              transport: "stdio",
              command: "server",
              features: { sampling: { enabled: "true", required: false } },
            }, manifest),
            metadata: [],
          }],
          foreign: [],
        },
      }),
      capabilities: capabilities(),
    });
    expect(malformedFeature.components[0]?.verdict.kind).toBe("metadata-only");
    expect(malformedFeature.components[0]?.diagnostics[0]?.code).toBe("UNSUPPORTED_DECLARATION");
    expect(malformedFeature.components[0]?.diagnostics[0]?.location?.pointer).toBe("/components/features/sampling/enabled");
    expect(malformedFeature.components[0]?.diagnostics[0]?.details).toMatchObject({
      field: "features.sampling.enabled",
      ruleId: "mcp.default-deny",
    });
  });

  it("degrades bearer/OAuth selector conflicts and credential-bearing MCP URLs to metadata only", () => {
    const combinedAuth = evaluateCompatibility({
      plugin: plugin({
        components: {
          skills: [],
          hooks: [],
          mcpServers: [{
            kind: "mcp-server",
            id: componentId("mcp-server", "8"),
            nativeKey: claim("combined-auth", manifest),
            declaration: claim({
              transport: "streamable-http",
              url: "https://example.invalid/mcp",
              auth: { type: "oauth", env: "CANARY_BEARER_ENV", grantType: "authorization-code" },
            }, manifest),
            metadata: [],
          }],
          foreign: [],
        },
      }),
      capabilities: capabilities(),
    });
    expect(combinedAuth.components[0]?.verdict.kind).toBe("metadata-only");
    expect(combinedAuth.components[0]?.diagnostics[0]?.location?.pointer).toBe("/components/auth");
    expect(JSON.stringify(combinedAuth)).not.toContain("CANARY_BEARER_ENV");

    const embeddedCredentials = evaluateCompatibility({
      plugin: plugin({
        components: {
          skills: [],
          hooks: [],
          mcpServers: [{
            kind: "mcp-server",
            id: componentId("mcp-server", "9"),
            nativeKey: claim("credential-url", manifest),
            declaration: claim({
              transport: "streamable-http",
              url: "https://CANARY_URL_USER:CANARY_URL_PASSWORD@example.invalid/mcp",
            }, manifest),
            metadata: [],
          }],
          foreign: [],
        },
      }),
      capabilities: capabilities(),
    });
    expect(embeddedCredentials.components[0]?.verdict.kind).toBe("metadata-only");
    expect(embeddedCredentials.components[0]?.diagnostics[0]?.location?.pointer).toBe("/components/url");
    expect(JSON.stringify(embeddedCredentials)).not.toContain("CANARY_URL_USER");
    expect(JSON.stringify(embeddedCredentials)).not.toContain("CANARY_URL_PASSWORD");
  });

  it("keeps bearer-only and OAuth-only authentication supported with complete requirements", () => {
    const report = evaluateCompatibility({
      plugin: plugin({
        components: {
          skills: [],
          hooks: [],
          mcpServers: [{
            kind: "mcp-server",
            id: componentId("mcp-server", "a"),
            nativeKey: claim("bearer-only", manifest),
            declaration: claim({
              transport: "streamable-http",
              url: "https://example.invalid/bearer-only",
              auth: { type: "bearer", env: "MCP_BEARER_TOKEN" },
            }, manifest),
            metadata: [],
          }, {
            kind: "mcp-server",
            id: componentId("mcp-server", "b"),
            nativeKey: claim("oauth-only", manifest),
            declaration: claim({
              transport: "streamable-http",
              url: "https://example.invalid/oauth-only",
              oauth: { type: "oauth", grantType: "authorization-code", clientId: "client" },
            }, manifest),
            metadata: [],
          }],
          foreign: [],
        },
      }),
      capabilities: capabilities(),
    });
    expect(report.components.map((assessment) => assessment.verdict.kind)).toEqual(["supported", "supported"]);
    expect(report.activatable).toBe(true);
    expect(report.requirements.map((assessment) => assessment.requirement.capability)).toEqual([
      "pi.mcp.runtime",
      "pi.mcp.transport.streamable-http",
      "pi.mcp.runtime",
      "pi.mcp.transport.streamable-http",
      "pi.mcp.oauth.authorization-code",
    ]);
    expect(report.diagnostics).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(/MCP_BEARER_TOKEN/u);

  });

  it("retains transport- and feature-specific MCP requirement rules and provenance", () => {
    const mcpSource = (pointer: string): Provenance => ({
      location: {
        host: "claude",
        documentKind: "mcp",
        path: "plugin.mcp.json",
        pointer,
      },
    });
    const stdioId = componentId("mcp-server", "c");
    const httpId = componentId("mcp-server", "d");
    const report = evaluateCompatibility({
      plugin: plugin({
        components: {
          skills: [],
          hooks: [],
          foreign: [],
          mcpServers: [{
            kind: "mcp-server",
            id: stdioId,
            nativeKey: claim("stdio", mcpSource("/native/stdio")),
            declaration: claim({ transport: "stdio", command: "server", sampling: true }, mcpSource("/mcp/stdio")),
            metadata: [],
          }, {
            kind: "mcp-server",
            id: httpId,
            nativeKey: claim("http", mcpSource("/native/http")),
            declaration: claim({ transport: "streamable-http", url: "https://example.invalid/mcp" }, mcpSource("/mcp/http")),
            metadata: [],
          }],
        },
      }),
      capabilities: capabilities({ "pi.mcp.runtime": "unavailable" }),
    });

    const requirement = (id: string, capability: string) => report.requirements.find((entry) =>
      entry.requirement.id.endsWith(`:${id}`) && entry.requirement.capability === capability);
    expect(requirement(stdioId, "pi.mcp.runtime")?.requirement.provenance.map((entry) => entry.location.pointer)).toEqual(["/mcp/stdio"]);
    expect(requirement(stdioId, "pi.mcp.sampling")?.requirement.provenance.map((entry) => entry.location.pointer)).toEqual(["/mcp/stdio/sampling"]);
    expect(requirement(httpId, "pi.mcp.runtime")?.requirement.provenance.map((entry) => entry.location.pointer)).toEqual(["/mcp/http"]);

    const unavailableRule = (id: string) => (report.diagnostics.find((diagnostic) =>
      diagnostic.code === "REQUIREMENT_UNAVAILABLE" &&
      (diagnostic.details as { componentId?: string } | undefined)?.componentId === id)?.details as
        { policyRuleId?: string } | undefined)?.policyRuleId;
    expect(unavailableRule(stdioId)).toBe("mcp.transport.stdio");
    expect(unavailableRule(httpId)).toBe("mcp.transport.streamable-http");
  });

  it("is deterministic across component and claim insertion order", () => {
    const first = plugin();
    const second = plugin({
      components: {
        skills: [...first.components.skills].reverse(),
        hooks: [...first.components.hooks].reverse(),
        mcpServers: [...first.components.mcpServers].reverse(),
        foreign: [...first.components.foreign].reverse(),
      },
    });
    expect(JSON.stringify(evaluateCompatibility({ plugin: first, capabilities: capabilities() }))).toBe(
      JSON.stringify(evaluateCompatibility({ plugin: second, capabilities: capabilities() })),
    );
  });
});
