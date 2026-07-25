import { describe, expect, it } from "vitest";
import { createResolvedConfiguration } from "../../../src/application/resolved-configuration.js";
import {
  McpConfigSourceSchemaV1,
  type McpConfigSource,
  type McpLaunchValues,
} from "../../../src/application/ports/mcp-runtime.js";
import {
  McpLaunchErrorCodes,
  type McpLaunchContextPort,
} from "../../../src/application/ports/mcp-launch-context.js";
import {
  McpLaunchTemplateSchemaV1,
  type McpLaunchTemplate,
} from "../../../src/domain/mcp-launch-template.js";
import { ComponentIdSchema } from "../../../src/domain/components.js";
import { ContentDigestSchema } from "../../../src/domain/content-manifest.js";
import { PluginKeySchema } from "../../../src/domain/identity.js";
import { SourceLocationSchema } from "../../../src/domain/provenance-location.js";
import { createTrustedMcpLaunchValueProvider } from "../../../src/runtime/mcp/launch-value-provider.js";
import { classifyMcpLaunchFailure } from "../../../src/runtime/mcp/launch-error.js";
import { FakeMcpLaunchEnvironment } from "../../support/fakes/mcp-launch-context.js";

const location = SourceLocationSchema.parse({
  host: "claude",
  documentKind: "mcp",
  path: "plugin.mcp.json",
  pointer: "/mcpServers/search",
});
const componentId = ComponentIdSchema.parse(`component-v1:mcp-server:${"a".repeat(64)}`);
const serverKey = `mcp-server-v1:${"a".repeat(64)}`;
const digest = (hex: string) => ContentDigestSchema.parse(`sha256:${hex.repeat(64).slice(0, 64)}`);
const identity = {
  schemaVersion: 1 as const,
  scope: { kind: "user" as const },
  plugin: PluginKeySchema.parse("demo@community"),
  revision: digest("1"),
  projectionDigest: digest("2"),
};

function stdioTemplate(overrides: Record<string, unknown> = {}): McpLaunchTemplate {
  return McpLaunchTemplateSchemaV1.parse({
    schemaVersion: 1,
    transport: "stdio",
    command: "${PLUGIN_ROOT}/bin/server",
    args: ["--token", "${user_config.TOKEN}", "$HOME", "$(literal)"],
    cwd: "${CLAUDE_PROJECT_DIR}",
    env: [{ name: "DECLARED", value: "${AMBIENT}" }],
    ...overrides,
  });
}

function httpTemplate(overrides: Record<string, unknown> = {}): McpLaunchTemplate {
  return McpLaunchTemplateSchemaV1.parse({
    schemaVersion: 1,
    transport: "streamable-http",
    endpointSecurity: "tls",
    url: "https://example.invalid/mcp?name=${user_config.NAME}",
    headers: [
      { name: "X-Ambient", value: { kind: "environment", name: "HEADER_VALUE" } },
      { name: "X-Static", value: { kind: "template", template: "safe" } },
    ],
    bearerToken: { kind: "environment", name: "CLAUDE_PLUGIN_OPTION_TOKEN" },
    ...overrides,
  });
}

function setup(options: Readonly<{
  template?: McpLaunchTemplate;
  configured?: readonly Readonly<{ key: string; value: { kind: "string"; value: string } }>[];
  ambient?: Readonly<Record<string, string>>;
  platform?: "posix" | "windows";
  afterContext?: (signal: AbortSignal) => void;
}> = {}) {
  const template = options.template ?? stdioTemplate();
  const parsedSource = McpConfigSourceSchemaV1.parse({
    schemaVersion: 1,
    identity,
    servers: {
      [serverKey]: {
        componentId,
        nativeKey: "search",
        transport: template.transport,
        options: {
          schemaVersion: 1,
          auth: template.transport === "streamable-http" && template.bearerToken !== undefined
            ? { kind: "bearer-environment" }
            : { kind: "none" },
        },
        projection: {
          schemaVersion: 1,
          componentId,
          contentRef: `plugin-content-v1:sha256:${"c".repeat(64)}`,
          dataRef: `plugin-data-v1:sha256:${"d".repeat(64)}`,
        },
        launchTemplate: template,
        toolAliases: [],
        provenance: [location],
      },
    },
  });
  const source = JSON.parse(JSON.stringify(parsedSource)) as McpConfigSource;
  let callbacks = 0;
  const context: McpLaunchContextPort = {
    async withContext(binding, signal, use) {
      signal.throwIfAborted();
      callbacks += 1;
      const configuration = createResolvedConfiguration(options.configured ?? [
        { key: "NAME", value: { kind: "string", value: "demo" } },
        { key: "TOKEN", value: { kind: "string", value: "CANARY_${NOT_REPARSED}" } },
      ]);
      try {
        await use({
          binding,
          pluginRoot: "/plugin",
          pluginDataRoot: "/data",
          projectRoot: "file:///project/",
          projection: parsedSource.servers[serverKey]!.projection,
          template,
          configuration,
        });
        options.afterContext?.(signal);
      } finally {
        configuration.dispose();
      }
    },
  };
  const environment = new FakeMcpLaunchEnvironment(options.ambient ?? {
    AMBIENT: "ambient-value",
    HEADER_VALUE: "header-value",
  });
  const provider = createTrustedMcpLaunchValueProvider({
    source,
    context,
    environment,
    platform: options.platform ?? "posix",
  });
  const request = {
    schemaVersion: 1 as const,
    source: identity,
    serverKey,
    componentId,
    transport: template.transport,
  } as const;
  return { provider, request, source, context, environment, get callbacks() { return callbacks; } };
}

function code(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
}

describe("trusted MCP launch value provider", () => {
  it("renders literal stdio values, roots, configuration, and requested ambient names once", async () => {
    const fixture = setup();
    const values = await fixture.provider.resolve(fixture.request, new AbortController().signal);
    expect(values.transport).toBe("stdio");
    if (values.transport !== "stdio") throw new Error("expected stdio values");
    expect(values.command).toBe("/plugin/bin/server");
    expect(values.args).toEqual(["--token", "CANARY_${NOT_REPARSED}", "$HOME", "$(literal)"]);
    expect(values.cwd).toBe("file:///project/");
    expect(values.env).toMatchObject({
      CLAUDE_PLUGIN_ROOT: "/plugin",
      PLUGIN_ROOT: "/plugin",
      CLAUDE_PLUGIN_DATA: "/data",
      PLUGIN_DATA: "/data",
      CLAUDE_PROJECT_DIR: "file:///project/",
      CLAUDE_PLUGIN_OPTION_NAME: "demo",
      CLAUDE_PLUGIN_OPTION_TOKEN: "CANARY_${NOT_REPARSED}",
      DECLARED: "ambient-value",
    });
    expect(Object.getPrototypeOf(values.env)).toBeNull();
    expect(fixture.environment.requests).toEqual([["AMBIENT"]]);
    expect(JSON.stringify(values)).toBe('"[REDACTED]"');
    expect(String(values)).toBe("[REDACTED]");
    expect(Object.isFrozen(values.args)).toBe(true);
    fixture.provider.dispose(values);
    expect(() => values.transport).toThrow("disposed");
    fixture.provider.dispose(values);
  });

  it("treats prototype-like configuration and environment names as owned data only", async () => {
    const fixture = setup({
      template: stdioTemplate({
        command: "${user_config.__proto__}",
        args: [],
        cwd: undefined,
        env: [{ name: "__proto__", value: "${user_config.constructor}" }],
      }),
      configured: [
        { key: "__proto__", value: { kind: "string", value: "/safe/command" } },
        { key: "constructor", value: { kind: "string", value: "safe-value" } },
      ],
    });
    const values = await fixture.provider.resolve(fixture.request, new AbortController().signal);
    expect(values.transport).toBe("stdio");
    if (values.transport !== "stdio") throw new Error("expected stdio values");
    expect(values.command).toBe("/safe/command");
    expect(Object.getPrototypeOf(values.env)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(values.env, "__proto__")).toBe(true);
    expect(values.env.__proto__).toBe("safe-value");
    expect(values.env.CLAUDE_PLUGIN_OPTION___proto__).toBe("/safe/command");
    fixture.provider.dispose(values);
  });

  it("maps Streamable HTTP URL, headers, and configured bearer without ambient over-read", async () => {
    const fixture = setup({ template: httpTemplate() });
    const values = await fixture.provider.resolve(fixture.request, new AbortController().signal);
    expect(values.transport).toBe("streamable-http");
    if (values.transport !== "streamable-http") throw new Error("expected HTTP values");
    expect(values.url).toBe("https://example.invalid/mcp?name=demo");
    expect(values.headers).toEqual({ "X-Ambient": "header-value", "X-Static": "safe" });
    expect(Object.getPrototypeOf(values.headers)).toBeNull();
    expect(values.bearerToken).toBe("CANARY_${NOT_REPARSED}");
    expect(fixture.environment.requests).toEqual([["HEADER_VALUE"]]);
    fixture.provider.dispose(values);
  });

  it("keeps structured environment selectors distinct from trusted root templates", async () => {
    const template = httpTemplate({
      headers: [
        { name: "X-Configured", value: { kind: "environment", name: "CLAUDE_PLUGIN_OPTION_NAME" } },
        { name: "X-Structured", value: { kind: "environment", name: "PLUGIN_ROOT" } },
        { name: "X-Template", value: { kind: "template", template: "${PLUGIN_ROOT}" } },
      ],
      bearerToken: undefined,
    });
    const fixture = setup({ template, ambient: { PLUGIN_ROOT: "ambient-plugin-root" } });
    const values = await fixture.provider.resolve(fixture.request, new AbortController().signal);
    expect(values.transport).toBe("streamable-http");
    if (values.transport !== "streamable-http") throw new Error("expected HTTP values");
    expect(values.headers).toEqual({
      "X-Configured": "demo",
      "X-Structured": "ambient-plugin-root",
      "X-Template": "/plugin",
    });
    expect(fixture.environment.requests).toEqual([["PLUGIN_ROOT"]]);
    fixture.provider.dispose(values);
  });

  it.each([
    {
      abortAt: "has" as const,
      reason: { name: "AbortError", code: "ABORT_ERR", message: "CANARY_FACADE_CANCEL" },
      expectedCode: McpLaunchErrorCodes.cancelled,
    },
    {
      abortAt: "substitute" as const,
      reason: { name: "TimeoutError", code: "TIMEOUT", message: "CANARY_FACADE_TIMEOUT" },
      expectedCode: McpLaunchErrorCodes.timeout,
    },
  ])(
    "propagates cancellation identity when ambient facade $abortAt aborts and disposes before rejection",
    async ({ abortAt, reason, expectedCode }) => {
      const template = httpTemplate({
        headers: [{ name: "X-Ambient", value: { kind: "environment", name: "HEADER_VALUE" } }],
        bearerToken: undefined,
      });
      const fixture = setup({ template });
      const controller = new AbortController();
      const events: string[] = [];
      fixture.environment.withResolved = async (_names, _signal, use) => {
        const facade = Object.freeze({
          has() {
            events.push("has");
            if (abortAt === "has") controller.abort(reason);
            return true;
          },
          substitute() {
            events.push("substitute");
            if (abortAt === "substitute") controller.abort(reason);
            return "CANARY_FACADE_VALUE";
          },
          redact: (text: string) => text,
          toString: () => "[REDACTED]" as const,
          toJSON: () => "[REDACTED]" as const,
        });
        try {
          await use(facade);
        } finally {
          events.push("disposed");
        }
      };
      const failure = await fixture.provider.resolve(fixture.request, controller.signal)
        .catch((error: unknown) => {
          events.push("rejected");
          return error;
        });
      expect(failure).toBe(reason);
      expect(classifyMcpLaunchFailure(failure, controller.signal)).toBe(expectedCode);
      expect(events.at(-2)).toBe("disposed");
      expect(events.at(-1)).toBe("rejected");
      if (abortAt === "has") expect(events).not.toContain("substitute");
      expect(JSON.stringify(failure)).toMatch(/CANARY_FACADE_(?:CANCEL|TIMEOUT)/u);
    },
  );

  it.each([
    ["missing configured variable", stdioTemplate({ command: "${CLAUDE_PLUGIN_OPTION_MISSING}" }), "posix"],
    ["prototype-like ambient variable", stdioTemplate({ command: "${__proto__}" }), "posix"],
    ["Windows collision", stdioTemplate({ env: [{ name: "PATH", value: "one" }, { name: "Path", value: "two" }] }), "windows"],
    ["reserved collision", stdioTemplate({ env: [{ name: "PLUGIN_ROOT", value: "other" }] }), "posix"],
  ] as const)("rejects %s without partial output", async (_name, template, platform) => {
    const fixture = setup({ template, platform });
    const error = await fixture.provider.resolve(fixture.request, new AbortController().signal)
      .catch((value: unknown) => value);
    expect(code(error)).toBe(McpLaunchErrorCodes.valueInvalid);
    expect(JSON.stringify(error)).not.toContain("CANARY_");
  });

  it.each([
    {
      template: httpTemplate({
        headers: [{ name: "X-Test", value: { kind: "environment", name: "HEADER_VALUE" } }],
        bearerToken: undefined,
      }),
      ambient: { HEADER_VALUE: "one\r\ntwo" },
    },
    {
      template: httpTemplate({ headers: [], bearerToken: { kind: "environment", name: "HEADER_VALUE" } }),
      ambient: { HEADER_VALUE: "white space" },
    },
  ])("rejects unsafe HTTP outputs with a stable redacted code", async ({ template, ambient }) => {
    const fixture = setup({ template, ambient });
    const error = await fixture.provider.resolve(fixture.request, new AbortController().signal)
      .catch((value: unknown) => value);
    expect(code(error)).toBe(McpLaunchErrorCodes.valueInvalid);
    expect(JSON.stringify(error)).not.toMatch(/password|white space|header-value/i);
  });

  it("uses POSIX exact and Windows case-insensitive environment collision rules", async () => {
    const template = stdioTemplate({ env: [{ name: "PATH", value: "one" }, { name: "Path", value: "two" }] });
    const posix = setup({ template, platform: "posix" });
    const values = await posix.provider.resolve(posix.request, new AbortController().signal);
    expect(values.transport === "stdio" && values.env).toMatchObject({ PATH: "one", Path: "two" });
    posix.provider.dispose(values);
    const windows = setup({ template, platform: "windows" });
    await expect(windows.provider.resolve(windows.request, new AbortController().signal))
      .rejects.toMatchObject({ code: McpLaunchErrorCodes.valueInvalid });
  });

  it("owns exact independent lease identity and rejects foreign-provider cleanup", async () => {
    const first = setup();
    const second = setup();
    const [left, right] = await Promise.all([
      first.provider.resolve(first.request, new AbortController().signal),
      first.provider.resolve(first.request, new AbortController().signal),
    ]);
    expect(left).not.toBe(right);
    if (left.transport === "stdio" && right.transport === "stdio") {
      expect(left.args).not.toBe(right.args);
      expect(left.env).not.toBe(right.env);
    }
    expect(() => second.provider.dispose(left)).toThrow();
    expect(left.transport).toBe("stdio");
    first.provider.dispose(left);
    first.provider.dispose(right);
  });

  it("rejects a tampered request key before context or environment dependencies", async () => {
    const fixture = setup();
    const error = await fixture.provider.resolve({
      ...fixture.request,
      serverKey: `mcp-server-v1:${"f".repeat(64)}`,
    }, new AbortController().signal).catch((value: unknown) => value);
    expect(code(error)).toBe(McpLaunchErrorCodes.authorityRejected);
    expect(fixture.callbacks).toBe(0);
    expect(fixture.environment.requests).toEqual([]);
  });

  it("copies registered source/template state before caller mutation", async () => {
    const fixture = setup();
    (fixture.source.servers[serverKey]!.launchTemplate as { command?: string }).command = "MUTATED";
    const values = await fixture.provider.resolve(fixture.request, new AbortController().signal);
    expect(values.transport === "stdio" && values.command).toBe("/plugin/bin/server");
    fixture.provider.dispose(values);
  });

  it("does no work on pre-abort and disposes locally when abort wins before return", async () => {
    const pre = setup();
    const before = new AbortController();
    const preReason = new Error("pre-abort");
    before.abort(preReason);
    await expect(pre.provider.resolve(pre.request, before.signal)).rejects.toBe(preReason);
    expect(pre.callbacks).toBe(0);

    const controller = new AbortController();
    const reason = new Error("post-issue-abort");
    const raced = setup({ afterContext: () => controller.abort(reason) });
    await expect(raced.provider.resolve(raced.request, controller.signal)).rejects.toBe(reason);
    expect(raced.environment.disposed).toBe(1);
  });

  it("classifies cancellation and timeout by reason kind/code without reading messages", () => {
    const cancelled = new AbortController();
    cancelled.abort(Object.assign(new Error("CANARY_CANCEL_MESSAGE"), { name: "AbortError" }));
    expect(classifyMcpLaunchFailure(cancelled.signal.reason, cancelled.signal))
      .toBe(McpLaunchErrorCodes.cancelled);
    const timedOut = new AbortController();
    timedOut.abort({ name: "TimeoutError", message: "CANARY_TIMEOUT_MESSAGE" });
    expect(classifyMcpLaunchFailure(timedOut.signal.reason, timedOut.signal))
      .toBe(McpLaunchErrorCodes.timeout);
  });

  it("propagates exact cancellation during ambient resolution without issuing values", async () => {
    const fixture = setup();
    const controller = new AbortController();
    const reason = Object.assign(new Error("CANARY_AMBIENT_ABORT"), { name: "AbortError" });
    fixture.environment.withResolved = async () => {
      controller.abort(reason);
      throw reason;
    };
    await expect(fixture.provider.resolve(fixture.request, controller.signal)).rejects.toBe(reason);
  });

  it("propagates an abort-shaped ambient rejection unchanged while the signal remains active", async () => {
    const fixture = setup();
    const abort = Object.assign(new Error("adapter cancelled"), { code: "ABORT_ERR" });
    fixture.environment.withResolved = async () => { throw abort; };
    await expect(fixture.provider.resolve(fixture.request, new AbortController().signal)).rejects.toBe(abort);
  });

  it("maps ambient adapter failures without retaining native messages", async () => {
    const fixture = setup();
    fixture.environment.withResolved = async () => { throw new Error("CANARY_ENVIRONMENT_FAILURE"); };
    const error = await fixture.provider.resolve(fixture.request, new AbortController().signal)
      .catch((value: unknown) => value);
    expect(code(error)).toBe(McpLaunchErrorCodes.environmentFailed);
    expect(JSON.stringify(error)).not.toContain("CANARY_ENVIRONMENT_FAILURE");
  });
});
