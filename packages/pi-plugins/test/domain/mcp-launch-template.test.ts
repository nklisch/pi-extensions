import { describe, expect, it } from "vitest";
import { CompatibilityPolicyRegistry } from "../../src/domain/compatibility-policy.js";
import { analyzeMcpCompatibility } from "../../src/domain/mcp-compatibility-plan.js";
import {
  McpEnvironmentNameSchema,
  McpHeaderNameSchema,
  McpLaunchTemplateError,
  McpLaunchTemplateSchemaV1,
  createMcpLaunchTemplate,
} from "../../src/domain/mcp-launch-template.js";
import { mcp } from "../fixtures/compatibility/mcp.js";

function component(declaration: Record<string, unknown>, token = "1") {
  return mcp(declaration, token) as never;
}

function template(declaration: Record<string, unknown>, token = "1") {
  return createMcpLaunchTemplate(component(declaration, token));
}

describe("canonical MCP launch templates", () => {
  it("canonicalizes aliases and declaration order into one deterministic secret-free shape", () => {
    const first = template({
      env: { ZED: "${ZED}", ALPHA: "${user_config.NAME}" },
      workingDirectory: "${PLUGIN_ROOT}/server",
      args: ["--root", "${CLAUDE_PLUGIN_ROOT}"],
      command: "node",
      type: "stdio",
    });
    const second = template({
      type: "stdio",
      command: "node",
      args: ["--root", "${CLAUDE_PLUGIN_ROOT}"],
      workingDirectory: "${PLUGIN_ROOT}/server",
      env: { ALPHA: "${user_config.NAME}", ZED: "${ZED}" },
    }, "2");
    expect(first).toEqual(second);
    expect(first).toEqual({
      schemaVersion: 1,
      transport: "stdio",
      command: "node",
      args: ["--root", "${CLAUDE_PLUGIN_ROOT}"],
      cwd: "${PLUGIN_ROOT}/server",
      env: [
        { name: "ALPHA", value: "${user_config.NAME}" },
        { name: "ZED", value: "${ZED}" },
      ],
    });
    expect(McpLaunchTemplateSchemaV1.parse(first)).toEqual(first);
  });

  it("uses registry launch aliases instead of a parallel template vocabulary", () => {
    const aliases = CompatibilityPolicyRegistry.mcp.keys.fieldGroups.workingDirectory.aliases as unknown as string[];
    const original = [...aliases];
    try {
      aliases.push("executionDirectory");
      const candidate = component({
        transport: "stdio",
        command: "node",
        executionDirectory: "${PLUGIN_ROOT}/server",
      });
      expect(analyzeMcpCompatibility({
        plugin: "demo@community",
        component: candidate,
      }).kind).toBe("supported");
      expect(createMcpLaunchTemplate(candidate, "demo@community")).toMatchObject({
        cwd: "${PLUGIN_ROOT}/server",
      });

      aliases.splice(aliases.indexOf("executionDirectory"), 1);
      expect(analyzeMcpCompatibility({
        plugin: "demo@community",
        component: candidate,
      }).kind).toBe("metadata-only");
      expect(() => createMcpLaunchTemplate(candidate, "demo@community")).toThrow(McpLaunchTemplateError);
    } finally {
      aliases.splice(0, aliases.length, ...original);
    }
  });

  it("canonicalizes HTTP headers and bearer selectors without credential plaintext", () => {
    expect(template({
      type: "http",
      url: "https://example.invalid/mcp?access_token=${user_config.TOKEN}",
      headers: {
        "X-Trace": "static-safe",
        Authorization: "Bearer ${HTTP_TOKEN}",
      },
    })).toEqual({
      schemaVersion: 1,
      transport: "streamable-http",
      endpointSecurity: "tls",
      url: "https://example.invalid/mcp?access_token=${user_config.TOKEN}",
      headers: [
        { name: "Authorization", value: { kind: "template", template: "Bearer ${HTTP_TOKEN}" } },
        { name: "X-Trace", value: { kind: "template", template: "static-safe" } },
      ],
    });
    expect(template({
      transport: "streamable-http",
      url: "https://example.invalid/mcp",
      auth: { type: "bearer", env: "MCP_TOKEN" },
    }, "3")).toMatchObject({ endpointSecurity: "tls", bearerToken: { kind: "environment", name: "MCP_TOKEN" } });
  });

  it("requires TLS except for consent-bound unauthenticated literal loopback", () => {
    expect(template({
      type: "http",
      url: "http://127.0.0.1:4318/mcp",
    }, "loopback")).toMatchObject({
      endpointSecurity: "consent-bound-loopback-plaintext",
      url: "http://127.0.0.1:4318/mcp",
      headers: [],
    });

    const rejected = [
      { type: "http", url: "http://example.invalid/mcp" },
      { type: "http", url: "http://localhost/mcp" },
      { type: "http", url: "http://127.0.0.1/mcp", headers: { "X-Trace": "safe" } },
      { type: "http", url: "http://127.0.0.1/mcp", bearerTokenEnv: "MCP_TOKEN" },
      { type: "http", url: "http://127.0.0.1/mcp?access_token=${TOKEN}" },
      { type: "http", url: "http://[::ffff:127.0.0.1]/mcp" },
      { type: "http", url: "https://${HOST}/mcp" },
      { type: "http", url: "https://example.invalid/${PATH_VALUE}" },
      { type: "http", url: "https://example.invalid/mcp#fragment" },
    ];
    for (const [index, declaration] of rejected.entries()) {
      const candidate = component(declaration, `transport-${index}`);
      expect(analyzeMcpCompatibility({ plugin: "demo@community", component: candidate }).kind).toBe("incompatible");
      expect(() => createMcpLaunchTemplate(candidate, "demo@community")).toThrow(McpLaunchTemplateError);
    }
  });

  it("collapses only exact-equivalent top-level and nested header aliases", () => {
    const headers = {
      Cookie: "session=${SESSION_COOKIE}",
      "X-Amz-Signature": { env: "AWS_SIGNATURE" },
      "X-Trace": "safe",
    };
    const first = component({
      type: "http",
      url: "https://example.invalid/mcp",
      headers,
      features: { headers },
    }, "headers-one");
    const second = component({
      features: { headers },
      headers,
      url: "https://example.invalid/mcp",
      type: "http",
    }, "headers-two");
    expect(analyzeMcpCompatibility({ plugin: "demo@community", component: first }).kind)
      .toBe("supported");
    expect(createMcpLaunchTemplate(first, "demo@community"))
      .toEqual(createMcpLaunchTemplate(second, "demo@community"));

    const conflict = component({
      type: "http",
      url: "https://example.invalid/mcp",
      headers: { "X-Trace": "one" },
      features: { headers: { "X-Trace": "CANARY_CONFLICTING_HEADER" } },
    }, "headers-conflict");
    const result = analyzeMcpCompatibility({ plugin: "demo@community", component: conflict });
    expect(result.kind).toBe("metadata-only");
    expect(JSON.stringify(result)).not.toContain("CANARY_CONFLICTING_HEADER");
    expect(() => createMcpLaunchTemplate(conflict, "demo@community"))
      .toThrow(McpLaunchTemplateError);
  });

  it.each([
    ["Cookie", "CANARY_COOKIE", "1"],
    ["X-Amz-Signature", "CANARY_AMZ_SIGNATURE", "2"],
    ["X-Sig", "CANARY_SIG", "3"],
    ["X-Session-Id", "CANARY_SESSION", "4"],
    ["X-JWT", "CANARY_JWT", "5"],
  ])("degrades static %s credential carriers while accepting late-bound equivalents", (name, canary, token) => {
    const unsafe = component({
      type: "http",
      url: "https://example.invalid/mcp",
      headers: { [name]: canary },
    }, token);
    const result = analyzeMcpCompatibility({ plugin: "demo@community", component: unsafe });
    expect(result.kind).toBe("metadata-only");
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(() => createMcpLaunchTemplate(unsafe, "demo@community"))
      .toThrow(McpLaunchTemplateError);

    expect(template({
      type: "http",
      url: "https://example.invalid/mcp",
      headers: { [name]: { env: "LATE_VALUE" } },
    }, `${token}a`)).toMatchObject({
      headers: [{ name, value: { kind: "environment", name: "LATE_VALUE" } }],
    });
  });

  it.each([
    ["sig", "6"],
    ["X-Amz-Signature", "7"],
    ["session", "8"],
    ["jwt", "9"],
  ])(
    "degrades static %s query credentials without serializing plaintext",
    (name, token) => {
      const canary = `CANARY_QUERY_${name}`;
      const unsafe = component({
        type: "http",
        url: `https://example.invalid/mcp?${name}=${canary}`,
      }, token);
      const result = analyzeMcpCompatibility({ plugin: "demo@community", component: unsafe });
      expect(result.kind).toBe("metadata-only");
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(template({
        type: "http",
        url: `https://example.invalid/mcp?${name}=\${LATE_QUERY}`,
      }, `${token}a`)).toMatchObject({ transport: "streamable-http" });
    },
  );

  it.each([
    { transport: "stdio", type: "http", command: "node" },
    { command: "node", cwd: "/one", workingDirectory: "/two" },
    { command: "node", env: { API_TOKEN: "plaintext" } },
    { type: "http", url: "https://example.invalid", headers: { Authorization: "Bearer plaintext" } },
    { type: "http", url: "https://example.invalid?api_key=plaintext" },
    { type: "http", url: "https://example.invalid", headers: { Alpha: "one", alpha: "two" } },
    { type: "http", url: "https://example.invalid", headers: { Authorization: "${TOKEN}" }, bearerTokenEnv: "TOKEN" },
    { type: "http", url: "https://example.invalid", auth: { type: "bearer", env: "ONE" }, bearerTokenEnv: "TWO" },
  ])("degrades conflicting aliases and literal credential material", (declaration) => {
    const candidate = component(declaration);
    expect(analyzeMcpCompatibility({
      plugin: "demo@community",
      component: candidate,
    }).kind).toBe("metadata-only");
    expect(() => createMcpLaunchTemplate(candidate, "demo@community")).toThrow(McpLaunchTemplateError);
  });

  it.each([
    "${unknown.name}",
    "${PLUGIN_ROOT",
    "${PLUGIN_${ROOT}}",
    "${}",
    "before\0after",
  ])("rejects malformed durable template syntax before provider construction", (command) => {
    expect(McpLaunchTemplateSchemaV1.safeParse({
      schemaVersion: 1,
      transport: "stdio",
      command,
      args: [],
      env: [],
    }).success).toBe(false);
  });

  it("uses strict portable name grammars without caller-spelling normalization", () => {
    expect(McpEnvironmentNameSchema.safeParse("VALID_name_1").success).toBe(true);
    expect(McpEnvironmentNameSchema.safeParse("BAD-NAME").success).toBe(false);
    expect(McpEnvironmentNameSchema.safeParse("9BAD").success).toBe(false);
    expect(McpHeaderNameSchema.safeParse("X.Valid-Header").success).toBe(true);
    expect(McpHeaderNameSchema.safeParse("Bad Header").success).toBe(false);
  });
});
