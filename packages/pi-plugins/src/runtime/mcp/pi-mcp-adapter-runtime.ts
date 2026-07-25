import type {
  McpAdapterInstance,
  McpAdapterOptions,
  McpInitialSource as PackageInitialSource,
  McpLaunchValueProvider as PackageLaunchValueProvider,
  McpLaunchValues as PackageLaunchValues,
  McpProgrammaticRuntime,
  McpRuntimeLease as PackageRuntimeLease,
  McpRuntimeLeaseProvider as PackageRuntimeLeaseProvider,
  McpSourceIdentity as PackageSourceIdentity,
  McpSourcePrecondition as PackageSourcePrecondition,
  McpSourceRegistration as PackageSourceRegistration,
  McpSourceReplaceRequest as PackageSourceReplaceRequest,
} from "@nklisch/pi-mcp-adapter/programmatic";
import { isAbortRejection } from "../../application/abort-rejection.js";
import {
  McpLaunchValueRequestSchema,
  McpRuntimeCapabilitiesSchemaV1,
  McpRuntimeServerBindingSchemaV1,
  McpSourceIdentitySchemaV1,
  McpSourcePreconditionSchemaV1,
  McpSourceRegistrationSchemaV1,
  McpSourceRemoveResultSchema,
  McpSourceReplaceResultSchema,
  McpSourceStatusSchema,
  McpSourceValidationResultSchema,
  type McpLaunchValueProvider,
  type McpLaunchValues,
  type McpRuntimeCapabilities,
  type McpRuntimeLease,
  type McpRuntimeLeaseProvider,
  type McpRuntimePort,
  type McpSourceIdentity,
  type McpSourceRegistration,
  type McpSourceReplaceRequest,
  type McpSourceValidationResult,
} from "../../application/ports/mcp-runtime.js";
import {
  BoundaryError,
  DiagnosticSchema,
  ErrorCodeRegistry,
  diagnosticFromZodError,
} from "../../domain/errors.js";

const PACKAGE_PROVIDER = Object.freeze({
  kind: "published-package" as const,
  packageName: "@nklisch/pi-mcp-adapter",
  version: "2.11.0-nklisch.3",
  integrity: "sha512-keVNCjw0ZldLr5p6TwB3UvM9dHc9SwhCHbSQQOvdR+nhMFRua2lHdAG3nMqmr9CK1torEd8e5PX3ZyptXXhmbQ==",
  nodeEngine: ">=22.19.0",
  piPeerRange: ">=0.79.1 <1",
  contractVersion: 1 as const,
});

type InitialSource = Readonly<{
  registration: McpSourceRegistration;
  launchValues: McpLaunchValueProvider;
  runtimeLeases: McpRuntimeLeaseProvider;
}>;

export type PiMcpRuntimeAdapter = Readonly<{
  extension: McpAdapterInstance["extension"];
  runtime: McpRuntimePort;
}>;

export type PiMcpAdapterFactory = (options: McpAdapterOptions) => McpAdapterInstance;

function safeIdentity(identity: McpSourceIdentity | undefined): McpSourceIdentity | undefined {
  if (identity === undefined) return undefined;
  const parsed = McpSourceIdentitySchemaV1.safeParse(identity);
  return parsed.success ? parsed.data : undefined;
}

function adapterFailure(
  operation: string,
  cause: unknown,
  identity?: McpSourceIdentity,
): BoundaryError {
  const source = safeIdentity(identity);
  return new BoundaryError({
    code: ErrorCodeRegistry.adapterFailed,
    operation,
    message: "published MCP runtime boundary failed",
    details: {
      boundary: "mcp-runtime",
      operation,
      ...(source === undefined ? {} : { source }),
    },
    cause,
  });
}

async function callPackage<T>(
  operation: string,
  signal: AbortSignal,
  invoke: () => Promise<T>,
  identity?: McpSourceIdentity,
): Promise<T> {
  signal.throwIfAborted();
  try {
    return await invoke();
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    if (isAbortRejection(cause)) throw cause;
    throw adapterFailure(operation, cause, identity);
  }
}

function invalidDiagnostic(operation: string) {
  return DiagnosticSchema.parse({
    code: ErrorCodeRegistry.sourceInvalid,
    severity: "error",
    operation,
    message: "MCP source operation was rejected",
    details: { sourceOperation: operation },
  });
}

function invalidRegistration(
  operation: string,
  input: unknown,
): ReturnType<typeof invalidDiagnostic> {
  const parsed = McpSourceRegistrationSchemaV1.safeParse(input);
  return parsed.success
    ? invalidDiagnostic(operation)
    : diagnosticFromZodError(parsed.error, { operation });
}

function packageRegistration(registration: McpSourceRegistration): PackageSourceRegistration {
  // The concrete package intentionally publishes wider JSON structural types.
  // The host schema is the stricter authority at this boundary.
  return registration as unknown as PackageSourceRegistration;
}

function packageIdentity(identity: McpSourceIdentity): PackageSourceIdentity {
  return identity as unknown as PackageSourceIdentity;
}

function packagePrecondition(expected: McpSourceReplaceRequest["expected"]): PackageSourcePrecondition {
  return expected as unknown as PackageSourcePrecondition;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function validStringRecord(value: unknown, header = false): boolean {
  return isRecord(value) && Object.entries(value).every(([key, entry]) =>
    key.length > 0 && typeof entry === "string" && (!header || !/[\r\n\0]/u.test(entry)));
}

/** Validate plaintext in place so custody/disposal remains with the original provider object. */
function validateLaunchValues(value: unknown, transport: "stdio" | "streamable-http"): asserts value is McpLaunchValues {
  if (!isRecord(value) || value.transport !== transport) throw new TypeError("MCP launch values are invalid");
  if (transport === "stdio") {
    if (!hasOnlyKeys(value, ["transport", "command", "args", "cwd", "env"]) ||
        typeof value.command !== "string" || value.command.length === 0 || value.command.includes("\0") ||
        !Array.isArray(value.args) || value.args.some((entry) => typeof entry !== "string" || entry.includes("\0")) ||
        value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.includes("\0")) ||
        value.env !== undefined && !validStringRecord(value.env)) {
      throw new TypeError("MCP standard-I/O launch values are invalid");
    }
    return;
  }
  if (!hasOnlyKeys(value, ["transport", "url", "headers", "bearerToken"]) ||
      typeof value.url !== "string" || value.url.length === 0 || /[\u0000-\u001f\u007f]/u.test(value.url) ||
      value.headers !== undefined && !validStringRecord(value.headers, true) ||
      value.bearerToken !== undefined && typeof value.bearerToken !== "string") {
    throw new TypeError("MCP Streamable HTTP launch values are invalid");
  }
  let url: URL;
  try { url = new URL(value.url); }
  catch { throw new TypeError("MCP Streamable HTTP launch URL is invalid"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username.length > 0 || url.password.length > 0) {
    throw new TypeError("MCP Streamable HTTP launch URL is invalid");
  }
}

function validateLaunchProvider(provider: McpLaunchValueProvider): void {
  if (!isRecord(provider) || typeof provider.resolve !== "function" || typeof provider.dispose !== "function") {
    throw new TypeError("MCP launch-value provider is invalid");
  }
}

function validateLeaseProvider(provider: McpRuntimeLeaseProvider): void {
  if (!isRecord(provider) || typeof provider.acquire !== "function" ||
      typeof provider.release !== "function" || typeof provider.drain !== "function") {
    throw new TypeError("MCP runtime-lease provider is invalid");
  }
}

function adaptLaunchProvider(provider: McpLaunchValueProvider): PackageLaunchValueProvider {
  validateLaunchProvider(provider);
  const issued = new WeakSet<object>();
  const disposed = new WeakSet<object>();
  const adapted: PackageLaunchValueProvider = {
    async resolve(
      requestInput: Parameters<PackageLaunchValueProvider["resolve"]>[0],
      signal: AbortSignal,
    ): Promise<PackageLaunchValues> {
      signal.throwIfAborted();
      const request = McpLaunchValueRequestSchema.parse(requestInput);
      let values: McpLaunchValues;
      try {
        values = await provider.resolve(request, signal);
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        throw cause;
      }
      try {
        validateLaunchValues(values, request.transport);
        if (issued.has(values as object)) throw new TypeError("MCP launch values were reused");
        issued.add(values as object);
        return values as PackageLaunchValues;
      } catch (cause) {
        // The package cannot dispose a value it never receives. Complete the
        // custody handoff locally when validation rejects the returned object.
        try { await provider.dispose(values); }
        catch { /* preserve the boundary validation failure */ }
        throw cause;
      }
    },
    async dispose(valuesInput: PackageLaunchValues): Promise<void> {
      const values = valuesInput as unknown as McpLaunchValues;
      if (!isRecord(values) || !issued.has(values as object) || disposed.has(values as object)) {
        throw new TypeError("MCP launch-value disposal ownership is invalid");
      }
      await provider.dispose(values);
      disposed.add(values as object);
    },
  };
  return Object.freeze(adapted);
}

function adaptLeaseProvider(provider: McpRuntimeLeaseProvider): PackageRuntimeLeaseProvider {
  validateLeaseProvider(provider);
  const active = new WeakSet<object>();
  const adapted: PackageRuntimeLeaseProvider = {
    async acquire(
      bindingInput: Parameters<PackageRuntimeLeaseProvider["acquire"]>[0],
      signal: AbortSignal,
    ): Promise<PackageRuntimeLease> {
      signal.throwIfAborted();
      const binding = McpRuntimeServerBindingSchemaV1.parse(bindingInput);
      const lease = await provider.acquire(binding, signal);
      if (!isRecord(lease) || active.has(lease as object)) {
        throw new TypeError("MCP runtime lease is invalid");
      }
      active.add(lease as object);
      return lease as unknown as PackageRuntimeLease;
    },
    async release(leaseInput: PackageRuntimeLease, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      const lease = leaseInput as unknown as McpRuntimeLease;
      if (!isRecord(lease) || !active.has(lease as object)) {
        throw new TypeError("MCP runtime-lease release ownership is invalid");
      }
      await provider.release(lease, signal);
      active.delete(lease as object);
    },
    drain(signal: AbortSignal) {
      signal.throwIfAborted();
      return provider.drain(signal);
    },
  };
  return Object.freeze(adapted);
}

function packageInitialSource(source: InitialSource): PackageInitialSource {
  const registration = McpSourceRegistrationSchemaV1.parse(source.registration);
  return Object.freeze({
    registration: packageRegistration(registration),
    launchValues: adaptLaunchProvider(source.launchValues),
    runtimeLeases: adaptLeaseProvider(source.runtimeLeases),
  });
}

function assertConcreteCapabilities(capabilities: McpRuntimeCapabilities): void {
  const lifecycleComplete = Object.values(capabilities.sourceLifecycle).every((value) => value === true);
  if (!lifecycleComplete ||
      capabilities.transports.stdio !== true || capabilities.transports.streamableHttp !== true ||
      capabilities.transports.legacySse !== false || capabilities.transports.websocket !== false ||
      capabilities.oauth.authorizationCode !== false || capabilities.oauth.clientCredentials !== false ||
      capabilities.features.toolApproval !== false || capabilities.features.resources !== true ||
      capabilities.features.pluginToolAliases !== false ||
      capabilities.features.elicitationUrl && !capabilities.features.elicitationForm) {
    throw new TypeError("published MCP runtime qualification facts drifted");
  }
}

function createRuntime(packageRuntime: McpProgrammaticRuntime): McpRuntimePort {
  const runtime: McpRuntimePort = {
    async capabilities(signal): Promise<McpRuntimeCapabilities> {
      const raw = await callPackage("mcpRuntime.capabilities", signal, () => packageRuntime.capabilities(signal));
      try {
        const capabilities = McpRuntimeCapabilitiesSchemaV1.parse({ ...raw, provider: PACKAGE_PROVIDER });
        assertConcreteCapabilities(capabilities);
        return capabilities;
      } catch (cause) {
        throw adapterFailure("mcpRuntime.capabilities", cause);
      }
    },

    async validateSource(registrationInput, signal) {
      signal.throwIfAborted();
      const registration = McpSourceRegistrationSchemaV1.safeParse(registrationInput);
      if (!registration.success) {
        return McpSourceValidationResultSchema.parse({
          ok: false,
          diagnostics: [diagnosticFromZodError(registration.error, { operation: "validateMcpSource" })],
        }) as McpSourceValidationResult;
      }
      const raw = await callPackage(
        "mcpRuntime.validateSource",
        signal,
        () => packageRuntime.validateSource(packageRegistration(registration.data), signal),
        registration.data.source.identity,
      );
      try { return McpSourceValidationResultSchema.parse(raw) as McpSourceValidationResult; }
      catch (cause) { throw adapterFailure("mcpRuntime.validateSource", cause, registration.data.source.identity); }
    },

    async replaceSource(requestInput, signal) {
      signal.throwIfAborted();
      const registration = McpSourceRegistrationSchemaV1.safeParse(requestInput?.registration);
      const expected = McpSourcePreconditionSchemaV1.safeParse(requestInput?.expected);
      if (!registration.success || !expected.success) {
        return McpSourceReplaceResultSchema.parse({
          kind: "rejected",
          diagnostics: [invalidRegistration("replaceMcpSource", requestInput?.registration)],
        });
      }
      let request: PackageSourceReplaceRequest;
      try {
        request = {
          registration: packageRegistration(registration.data),
          expected: packagePrecondition(expected.data),
          launchValues: adaptLaunchProvider(requestInput.launchValues),
          runtimeLeases: adaptLeaseProvider(requestInput.runtimeLeases),
        };
      } catch {
        return McpSourceReplaceResultSchema.parse({
          kind: "rejected",
          diagnostics: [invalidDiagnostic("replaceMcpSource")],
        });
      }
      const identity = registration.data.source.identity;
      const raw = await callPackage(
        "mcpRuntime.replaceSource",
        signal,
        () => packageRuntime.replaceSource(request, signal),
        identity,
      );
      try { return McpSourceReplaceResultSchema.parse(raw); }
      catch (cause) { throw adapterFailure("mcpRuntime.replaceSource", cause, identity); }
    },

    async removeSource(identityInput, signal) {
      signal.throwIfAborted();
      let identity: McpSourceIdentity;
      try { identity = McpSourceIdentitySchemaV1.parse(identityInput); }
      catch (cause) { throw adapterFailure("mcpRuntime.removeSource", cause); }
      const raw = await callPackage(
        "mcpRuntime.removeSource",
        signal,
        () => packageRuntime.removeSource(packageIdentity(identity), signal),
        identity,
      );
      try { return McpSourceRemoveResultSchema.parse(raw); }
      catch (cause) { throw adapterFailure("mcpRuntime.removeSource", cause, identity); }
    },

    async inspectSource(identityInput, signal) {
      signal.throwIfAborted();
      let identity: McpSourceIdentity;
      try { identity = McpSourceIdentitySchemaV1.parse(identityInput); }
      catch (cause) { throw adapterFailure("mcpRuntime.inspectSource", cause); }
      const raw = await callPackage(
        "mcpRuntime.inspectSource",
        signal,
        () => packageRuntime.inspectSource(packageIdentity(identity), signal),
        identity,
      );
      try { return raw === undefined ? undefined : McpSourceStatusSchema.parse(raw); }
      catch (cause) { throw adapterFailure("mcpRuntime.inspectSource", cause, identity); }
    },

    async inspectSources(signal) {
      const raw = await callPackage(
        "mcpRuntime.inspectSources",
        signal,
        () => packageRuntime.inspectSources(signal),
      );
      try { return Object.freeze(raw.map((status) => McpSourceStatusSchema.parse(status))); }
      catch (cause) { throw adapterFailure("mcpRuntime.inspectSources", cause); }
    },
  };
  return Object.freeze(runtime);
}

/**
 * The sole concrete package boundary. Creation validates and stores local,
 * secret-free sources only; the returned extension owns all Pi/tool/session
 * side effects and is invoked separately by composition.
 */
export function createPiMcpRuntime(input: Readonly<{
  packageFactory: PiMcpAdapterFactory;
  initialSources: readonly InitialSource[];
  fileDiscovery: "disabled";
}>): PiMcpRuntimeAdapter {
  try {
    if (!isRecord(input) || typeof input.packageFactory !== "function" ||
        input.fileDiscovery !== "disabled" || !Array.isArray(input.initialSources)) {
      throw new TypeError("isolated MCP runtime options are invalid");
    }
    const initialSources = input.initialSources.map(packageInitialSource);
    const adapter = input.packageFactory({ initialSources, fileDiscovery: "disabled" });
    if (!isRecord(adapter) || typeof adapter.extension !== "function" || !isRecord(adapter.runtime) ||
        !["capabilities", "validateSource", "replaceSource", "removeSource", "inspectSource", "inspectSources"]
          .every((name) => typeof (adapter.runtime as unknown as Record<string, unknown>)[name] === "function")) {
      throw new TypeError("published MCP runtime export is incomplete");
    }
    const runtime = createRuntime(adapter.runtime);
    return Object.freeze({
      runtime,
      extension(pi) {
        try { adapter.extension(pi); }
        catch (cause) { throw adapterFailure("registerPiMcpExtension", cause); }
      },
    });
  } catch (cause) {
    if (cause instanceof BoundaryError) throw cause;
    throw adapterFailure("createPiMcpRuntime", cause);
  }
}
