import { describe, expect, it } from "vitest";
import { analyzeMcpCompatibility } from "../../src/domain/mcp-compatibility-plan.js";
import { McpServerComponentSchema } from "../../src/domain/components.js";
import { claim } from "../../src/domain/provenance.js";
import { mcpPreExtractionDifferentialVectors } from "../fixtures/compatibility/mcp.js";

const provenance = {
  location: {
    host: "claude" as const,
    documentKind: "mcp" as const,
    path: "plugin.mcp.json",
    pointer: "/mcpServers/search",
  },
  declaration: { canary: "CANARY_PROVENANCE_DECLARATION" },
};

function component(declaration: Record<string, unknown>) {
  return McpServerComponentSchema.parse({
    kind: "mcp-server",
    id: `component-v1:mcp-server:${"a".repeat(64)}`,
    nativeKey: claim("search", provenance),
    declaration: claim(declaration, provenance),
    metadata: [],
  });
}

describe("MCP compatibility plan", () => {
  it("canonicalizes registry-owned aliases into a secret-free structural plan", () => {
    const result = analyzeMcpCompatibility({
      plugin: "demo@community",
      component: component({
        type: "http",
        url: "https://example.invalid/CANARY_URL_PATH",
        headers: { "X-Trace": "${CANARY_HEADER_ENV}" },
        bearerTokenEnv: "CANARY_BEARER_ENV",
        startupTimeout: 1200,
        timeout: 500,
        allowTools: ["zeta", "alpha", "alpha"],
        tools: { allow: ["alpha", "zeta"] },
        instructions: "read only",
        resources: ["docs"],
        sampling: true,
        elicitation: { form: true, url: false },
      }),
    });
    expect(result.kind).toBe("supported");
    if (result.kind !== "supported") throw new Error("fixture was incompatible");
    expect(result.plan).toMatchObject({
      transport: "streamable-http",
      options: {
        schemaVersion: 1,
        startupTimeoutMs: 1200,
        toolTimeoutMs: 500,
        allowedTools: ["alpha", "zeta"],
        instructions: "read only",
        resources: ["docs"],
        sampling: true,
        elicitation: { form: true, url: false },
        auth: { kind: "bearer-environment" },
      },
    });
    expect(result.plan.requirementCapabilityIds).toEqual([
      "pi.mcp.runtime",
      "pi.mcp.transport.streamable-http",
      "pi.mcp.sampling",
      "pi.mcp.elicitation.form",
      "pi.mcp.resources",
    ]);
    expect(JSON.stringify(result.plan)).not.toMatch(/CANARY_/u);
    expect(result.plan.provenance).toEqual([provenance.location]);
  });

  it("accepts only consent-bound unauthenticated literal loopback over plaintext HTTP", () => {
    const accepted = analyzeMcpCompatibility({
      plugin: "demo@community",
      component: component({ type: "http", url: "http://127.0.0.1:8080/mcp" }),
    });
    expect(accepted.kind).toBe("supported");

    for (const declaration of [
      { type: "http", url: "http://10.0.0.1/mcp" },
      { type: "http", url: "http://127.0.0.1/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
      { type: "http", url: "http://[::1]/mcp", auth: { type: "bearer", env: "TOKEN" } },
      { type: "http", url: "http://127.0.0.1/mcp?token=${TOKEN}" },
    ]) {
      const rejected = analyzeMcpCompatibility({ plugin: "demo@community", component: component(declaration) });
      expect(rejected.kind).toBe("incompatible");
      expect(JSON.stringify(rejected)).not.toContain("${TOKEN}");
    }
  });

  it.each(mcpPreExtractionDifferentialVectors)(
    "matches the pre-extraction $id verdict and canonical plan",
    (vector) => {
      const result = analyzeMcpCompatibility({
        plugin: "demo@community",
        component: component(vector.declaration),
      });
      expect(result.kind).toBe(vector.kind);
      if (result.kind === "supported" && vector.kind === "supported") {
        expect(result.plan.options).toMatchObject(vector.options);
        for (const capability of "capabilities" in vector ? vector.capabilities : []) {
          expect(result.plan.requirementCapabilityIds).toContain(capability);
        }
      } else if (result.kind === "incompatible" && vector.kind === "incompatible") {
        expect(result.diagnostics.map((diagnostic) =>
          (diagnostic.details as { field?: string } | undefined)?.field,
        )).toEqual(expect.arrayContaining([...vector.diagnosticFields]));
      }
    },
  );

  it.each([
    { startupTimeout: 1000, timeoutMs: 2000 },
    { allowTools: ["read"], allowedTools: ["write"] },
    { allowTools: ["read"], denyTools: ["read"] },
    { toolApproval: true, features: { toolApproval: true } },
    { transport: "stdio", type: "http", command: "server" },
    { transport: "streamable-http", url: "https://user:CANARY_PASSWORD@example.invalid" },
    { transport: "streamable-http", url: "https://example.invalid", auth: { type: "bearer", env: "CANARY_ENV", flow: "authorization-code" } },
  ])("degrades ambiguous or credential-bearing shape without serializing secrets %#", (declaration) => {
    const result = analyzeMcpCompatibility({
      plugin: "demo@community",
      component: component(declaration),
    });
    // Degraded servers are retained as metadata only: skipped at activation,
    // never executed with ambiguous or literal-credential declarations.
    expect(result.kind).toBe("metadata-only");
    expect(JSON.stringify(result)).not.toMatch(/CANARY_/u);
  });
});
