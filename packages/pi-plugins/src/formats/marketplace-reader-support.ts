import { z } from "zod";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  BoundaryError,
  type Diagnostic,
} from "../domain/errors.js";
import { claim, type Claimed, type NativeHost, type Provenance } from "../domain/provenance.js";
import {
  SourceLocationSchema,
  type SourceLocation,
} from "../domain/provenance-location.js";
import {
  MarketplaceAvailabilityRegistry,
  MarketplaceInstallationPolicySchema,
  type MarketplaceInstallationPolicy,
} from "../domain/marketplace.js";
import type { MarketplaceEntryDeclaration } from "../domain/marketplace.js";
import {
  JsonValueSchema,
  type JsonValue,
} from "../domain/schema.js";
import { type RetainedMetadata, RetainedMetadataSchema } from "../domain/components.js";
import { type PluginKey } from "../domain/identity.js";

export type MarketplaceReaderOptions = Readonly<{
  path?: string;
}>;

export const MarketplaceEntryDeclarationRegistry = {
  skills: { category: "component" },
  commands: { category: "component" },
  agents: { category: "component" },
  hooks: { category: "component" },
  mcpServers: { category: "component" },
  lspServers: { category: "component" },
  settings: { category: "runtime-metadata" },
  outputStyles: { category: "runtime-metadata" },
  dependencies: { category: "dependency" },
  plugins: { category: "dependency" },
} as const satisfies Readonly<Record<string, { readonly category: MarketplaceEntryDeclaration["category"] }>>;

export type MarketplaceEntryDeclarationField = keyof typeof MarketplaceEntryDeclarationRegistry;

const installationValues = {
  AVAILABLE: MarketplaceAvailabilityRegistry.available,
  INSTALLED_BY_DEFAULT: MarketplaceAvailabilityRegistry.installedByDefault,
  NOT_AVAILABLE: MarketplaceAvailabilityRegistry.notAvailable,
} as const;

/**
 * Encode an RFC 6901 JSON Pointer. The empty pointer is the document root;
 * `/` is a pointer to a property whose name is the empty string.
 */
export function jsonPointer(...segments: readonly (string | number)[]): string {
  if (segments.length === 0) {
    return "";
  }
  return `/${segments
    .map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/")}`;
}

/**
 * Validate only the lexical form of a marketplace-relative path. Containment,
 * realpath, and symlink checks intentionally belong to source materialization.
 */
export function validateCatalogRelativePath(path: unknown, pointer: string): string {
  if (typeof path !== "string") {
    throw new TypeError(`Expected a relative catalog path at ${pointer}`);
  }
  if (
    path.length < 3 ||
    !path.startsWith("./") ||
    path === "./" ||
    path.includes("\\") ||
    path.includes("\u0000")
  ) {
    throw new TypeError(`Invalid relative catalog path at ${pointer}: ${path}`);
  }

  const segments = path.slice(2).split("/");
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    /^[A-Za-z]:/.test(path.slice(2))
  ) {
    throw new TypeError(`Invalid relative catalog path at ${pointer}: ${path}`);
  }
  return path;
}

/**
 * Git subdirectory declarations are relative to a remote repository rather
 * than the marketplace checkout. The documented forms use both `plugin` and
 * `./plugin`, so both are accepted while traversal syntax is rejected.
 */
export function validateRelativeSubdirectoryPath(path: unknown, pointer: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError(`Expected a relative repository path at ${pointer}`);
  }
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new TypeError(`Invalid relative repository path at ${pointer}: ${path}`);
  }

  const candidate = path.startsWith("./")
    ? validateCatalogRelativePath(path, pointer).slice(2)
    : path;
  const segments = candidate.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError(`Invalid relative repository path at ${pointer}: ${path}`);
  }
  // `plugin` and `./plugin` identify the same repository subdirectory. Keep
  // the exact foreign spelling in the source claim's provenance, but expose
  // one canonical domain path so dual catalogs can reconcile it.
  return candidate;
}

export function joinCatalogRelativePath(root: string | undefined, path: string, pointer: string): string {
  const child = validateCatalogRelativePath(path, pointer);
  if (root === undefined) {
    return child;
  }
  const parent = validateCatalogRelativePath(root, `${pointer} (pluginRoot)`);
  return `./${parent.slice(2)}/${child.slice(2)}`;
}

export function documentPath(
  options: MarketplaceReaderOptions | undefined,
  fallback: string,
): string {
  if (options?.path === undefined) {
    return fallback;
  }
  if (typeof options.path !== "string" || options.path.length === 0) {
    throw new TypeError("MarketplaceReaderOptions.path must be a non-empty string");
  }
  return options.path;
}

export function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function own(
  value: { readonly [key: string]: JsonValue },
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function readJsonDocument(
  json: string,
  operation: string,
  nativeHost: NativeHost,
  path: string,
): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (cause) {
    throw new BoundaryError({
      code: ErrorCodeRegistry.marketplaceRootInvalid,
      operation,
      message: `Invalid JSON in ${path}`,
      location: sourceLocation(nativeHost, path, jsonPointer()),
      cause,
    });
  }
}

export function readRootRecord(
  input: unknown,
  operation: string,
  nativeHost: NativeHost,
  path: string,
): { readonly [key: string]: JsonValue } {
  let value: JsonValue;
  try {
    value = JsonValueSchema.parse(input);
  } catch (cause) {
    const details: JsonValue | undefined = cause instanceof z.ZodError
      ? {
          issues: cause.issues.map((issue) => ({
            code: issue.code,
            path: issue.path.map(String),
            message: issue.message,
          })),
        }
      : undefined;
    throw rootInvalid(operation, nativeHost, path, "Marketplace root must be a JSON object", details);
  }
  if (!isJsonRecord(value)) {
    throw rootInvalid(operation, nativeHost, path, "Marketplace root must be a JSON object");
  }
  return value;
}

export function sourceLocation(
  nativeHost: NativeHost,
  path: string,
  pointer: string,
): SourceLocation {
  return SourceLocationSchema.parse({
    host: nativeHost,
    documentKind: "marketplace",
    path,
    pointer,
  });
}

export function provenanceAt(
  nativeHost: NativeHost,
  path: string,
  pointer: string,
  declaration?: JsonValue,
): Provenance {
  const location = sourceLocation(nativeHost, path, pointer);
  return declaration === undefined ? { location } : { location, declaration };
}

export function claimedFrom<T>(value: T, provenance: readonly [Provenance, ...Provenance[]]): Claimed<T> {
  return { value, provenance };
}

export function claimAt<T>(
  value: T,
  nativeHost: NativeHost,
  path: string,
  pointer: string,
  declaration?: JsonValue,
): Claimed<T> {
  return claim(value, provenanceAt(nativeHost, path, pointer, declaration));
}

export function rootInvalid(
  operation: string,
  nativeHost: NativeHost,
  path: string,
  message: string,
  details?: JsonValue,
  cause?: unknown,
  pointer = jsonPointer(),
): BoundaryError {
  const input = {
    code: ErrorCodeRegistry.marketplaceRootInvalid,
    operation,
    message,
    location: sourceLocation(nativeHost, path, pointer),
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  } as const;
  return new BoundaryError(input);
}

export type MarketplaceEntryErrorCode =
  | "ENTRY_INVALID"
  | "IDENTITY_INVALID"
  | "SOURCE_INVALID";

export class MarketplaceEntryError extends Error {
  readonly code: MarketplaceEntryErrorCode;
  readonly pointer: string;
  readonly plugin?: PluginKey;
  readonly details?: JsonValue;

  constructor(input: Readonly<{
    code: MarketplaceEntryErrorCode;
    pointer: string;
    message: string;
    plugin?: PluginKey;
    details?: JsonValue;
  }>) {
    super(input.message);
    this.name = "MarketplaceEntryError";
    this.code = input.code;
    this.pointer = input.pointer;
    if (input.plugin !== undefined) {
      this.plugin = input.plugin;
    }
    if (input.details !== undefined) {
      this.details = input.details;
    }
  }
}

export function entryError(
  code: MarketplaceEntryErrorCode,
  pointer: string,
  message: string,
  plugin?: PluginKey,
  details?: JsonValue,
): MarketplaceEntryError {
  return new MarketplaceEntryError({
    code,
    pointer,
    message,
    ...(plugin === undefined ? {} : { plugin }),
    ...(details === undefined ? {} : { details }),
  });
}

export function entryDiagnostic(
  error: MarketplaceEntryError,
  operation: string,
  nativeHost: NativeHost,
  path: string,
): Diagnostic {
  return DiagnosticSchema.parse({
    code: error.code,
    severity: "error",
    operation,
    message: error.message,
    location: sourceLocation(nativeHost, path, error.pointer),
    ...(error.plugin === undefined ? {} : { plugin: error.plugin }),
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}

export function zodDetails(error: z.ZodError): JsonValue {
  return {
    issues: error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String),
      message: issue.message,
    })),
  };
}

export function requireString(
  value: JsonValue | undefined,
  field: string,
  pointer: string,
  options: Readonly<{ nonEmpty?: boolean }> = {},
): string {
  if (typeof value !== "string" || (options.nonEmpty === true && value.length === 0)) {
    throw entryError("ENTRY_INVALID", pointer, `${field} must be a${options.nonEmpty === true ? " non-empty" : ""} string`);
  }
  return value;
}

export function requireRecord(
  value: JsonValue | undefined,
  field: string,
  pointer: string,
): { readonly [key: string]: JsonValue } {
  if (value === undefined || !isJsonRecord(value)) {
    throw entryError("ENTRY_INVALID", pointer, `${field} must be an object`);
  }
  return value;
}

export function readPluginRoot(
  root: { readonly [key: string]: JsonValue },
  nativeHost: NativeHost,
  path: string,
  operation: string,
): {
  readonly root: string | undefined;
  readonly pluginRootProvenance: Provenance | undefined;
  readonly metadata: RetainedMetadata[];
} {
  const metadataValue = root.metadata;
  if (metadataValue === undefined) {
    return { root: undefined, pluginRootProvenance: undefined, metadata: [] };
  }
  if (!isJsonRecord(metadataValue)) {
    throw rootInvalid(operation, nativeHost, path, "Marketplace root metadata must be an object", {
      pointer: jsonPointer("metadata"),
    }, undefined, jsonPointer("metadata"));
  }

  let pluginRoot: string | undefined;
  let pluginRootProvenance: Provenance | undefined;
  if (own(metadataValue, "pluginRoot")) {
    try {
      pluginRoot = validateCatalogRelativePath(
        metadataValue.pluginRoot,
        jsonPointer("metadata", "pluginRoot"),
      );
      pluginRootProvenance = provenanceAt(
        nativeHost,
        path,
        jsonPointer("metadata", "pluginRoot"),
        metadataValue.pluginRoot,
      );
    } catch (cause) {
      throw rootInvalid(
        operation,
        nativeHost,
        path,
        "Marketplace metadata.pluginRoot is invalid",
        { pointer: jsonPointer("metadata", "pluginRoot") },
        cause,
        jsonPointer("metadata", "pluginRoot"),
      );
    }
  }

  const retained: RetainedMetadata[] = [];
  for (const [key, value] of Object.entries(metadataValue)) {
    if (key === "pluginRoot") {
      continue;
    }
    retained.push(RetainedMetadataSchema.parse({
      key: `${nativeHost}.metadata.${key}`,
      claimed: claimAt(value, nativeHost, path, jsonPointer("metadata", key), value),
    }));
  }
  return { root: pluginRoot, pluginRootProvenance, metadata: retained };
}

export function collectRootMetadata(
  root: { readonly [key: string]: JsonValue },
  nativeHost: NativeHost,
  path: string,
): RetainedMetadata[] {
  const retained: RetainedMetadata[] = [];
  for (const [key, value] of Object.entries(root)) {
    if (key === "name" || key === "plugins" || key === "metadata") {
      continue;
    }
    retained.push(RetainedMetadataSchema.parse({
      key: `${nativeHost}.${key}`,
      claimed: claimAt(value, nativeHost, path, jsonPointer(key), value),
    }));
  }
  return retained;
}

export function collectEntryMetadata(
  entry: { readonly [key: string]: JsonValue },
  nativeHost: NativeHost,
  path: string,
  entryPointer: string,
  excluded: ReadonlySet<string>,
): RetainedMetadata[] {
  const retained: RetainedMetadata[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (excluded.has(key)) {
      continue;
    }
    retained.push(RetainedMetadataSchema.parse({
      key: `${nativeHost}.${key}`,
      claimed: claimAt(value, nativeHost, path, `${entryPointer}/${jsonPointer(key).slice(1)}`, value),
    }));
  }
  return retained;
}

export function readInstallationPolicy(
  raw: JsonValue,
  nativeHost: NativeHost,
  path: string,
  pointer: string,
): MarketplaceInstallationPolicy {
  if (!isJsonRecord(raw)) {
    throw entryError("ENTRY_INVALID", pointer, "policy must be an object");
  }
  const keys = new Set(Object.keys(raw));
  for (const key of keys) {
    if (key !== "installation" && key !== "authentication") {
      throw entryError("ENTRY_INVALID", `${pointer}/${jsonPointer(key).slice(1)}`, `policy field ${key} is not supported`);
    }
  }

  const installation = raw.installation;
  if (typeof installation !== "string" || !(installation in installationValues)) {
    throw entryError("ENTRY_INVALID", `${pointer}/installation`, "policy.installation is unknown or missing");
  }
  const authentication = raw.authentication;
  if (authentication !== undefined && (typeof authentication !== "string" || authentication.length === 0)) {
    throw entryError("ENTRY_INVALID", `${pointer}/authentication`, "policy.authentication must be a non-empty string");
  }

  const result = {
    availability: claimAt(
      installationValues[installation as keyof typeof installationValues],
      nativeHost,
      path,
      `${pointer}/installation`,
      installation,
    ),
    ...(authentication === undefined
      ? {}
      : {
          authentication: claimAt(
            authentication,
            nativeHost,
            path,
            `${pointer}/authentication`,
            authentication,
          ),
        }),
    declaration: claimAt(raw, nativeHost, path, pointer, raw),
  };
  return MarketplaceInstallationPolicySchema.parse(result);
}

function declarationPointer(pointer: string, segment: string | number): string {
  return `${pointer}/${jsonPointer(segment).slice(1)}`;
}

function invalidDeclaration(pointer: string, message: string): never {
  throw entryError("ENTRY_INVALID", pointer, message);
}

type DeclarationShape = Readonly<{
  hookKeys: ReadonlySet<string>;
  serverKeys: ReadonlySet<string>;
  settingsKeys: ReadonlySet<string>;
  dependencyKeys: ReadonlySet<string>;
  pluginKeys: ReadonlySet<string>;
}>;

const declarationShapes: Readonly<Record<NativeHost, DeclarationShape>> = {
  claude: {
    hookKeys: new Set([
      "hooks", "matcher", "description", "type", "command", "args", "timeout",
      "timeoutMs", "async", "asyncRewake", "statusMessage", "shell", "url",
      "prompt", "agent", "mcp_tool",
    ]),
    serverKeys: new Set([
      "type", "transport", "command", "args", "env", "cwd", "workingDirectory",
      "url", "httpUrl", "headers", "oauth", "timeout", "startupTimeout",
      "toolTimeout", "enabledTools", "disabledTools", "required", "path",
    ]),
    settingsKeys: new Set([
      "path", "scope", "enabled", "defaults", "env", "configuration", "settings",
      "userConfig", "user_config",
    ]),
    dependencyKeys: new Set([
      "name", "id", "package", "plugin", "source", "url", "path", "repo",
      "repository", "registry", "version", "selector", "constraint", "range",
      "ref", "sha", "optional", "platform", "policy",
    ]),
    pluginKeys: new Set([
      "name", "id", "source", "url", "path", "repo", "repository", "version",
      "selector", "ref", "sha", "strict", "dependencies", "policy",
    ]),
  },
  codex: {
    hookKeys: new Set([
      "hooks", "matcher", "description", "type", "command", "args", "timeout",
      "timeout_ms", "async", "shell", "url", "prompt", "agent", "mcp_tool",
    ]),
    serverKeys: new Set([
      "type", "transport", "command", "args", "env", "cwd", "working_directory",
      "url", "http_url", "http_headers", "headers", "bearer_token_env_var",
      "oauth", "startup_timeout_sec", "tool_timeout_sec", "enabled_tools",
      "disabled_tools", "required", "path",
    ]),
    settingsKeys: new Set([
      "path", "scope", "enabled", "defaults", "env", "configuration", "settings",
      "user_config", "userConfig",
    ]),
    dependencyKeys: new Set([
      "name", "id", "package", "plugin", "source", "url", "path", "repo",
      "repository", "registry", "version", "selector", "constraint", "range",
      "ref", "sha", "optional", "platform", "policy",
    ]),
    pluginKeys: new Set([
      "name", "id", "source", "url", "path", "repo", "repository", "version",
      "selector", "ref", "sha", "dependencies", "policy",
    ]),
  },
};

function shapeFor(nativeHost: NativeHost): DeclarationShape {
  return declarationShapes[nativeHost];
}

function validateNonEmptyString(value: JsonValue, pointer: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    invalidDeclaration(pointer, `${field} must be a non-empty string`);
  }
}

function validateStringList(
  value: JsonValue,
  pointer: string,
  field: string,
  allowEmpty = false,
): void {
  if (typeof value === "string") {
    validateNonEmptyString(value, pointer, field);
    return;
  }
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalidDeclaration(pointer, `${field} must be a${allowEmpty ? "" : " non-empty"} string array or path string`);
  }
  for (const [index, item] of value.entries()) {
    validateNonEmptyString(item, declarationPointer(pointer, index), `${field} item`);
  }
}

function nonEmptyRecord(
  value: JsonValue,
  pointer: string,
  field: string,
): { readonly [key: string]: JsonValue } {
  if (!isJsonRecord(value) || Object.keys(value).length === 0) {
    invalidDeclaration(pointer, `${field} must be a non-empty object`);
  }
  return value;
}

function validateBoolean(value: JsonValue, pointer: string, field: string): void {
  if (typeof value !== "boolean") {
    invalidDeclaration(pointer, `${field} must be a boolean`);
  }
}

function validatePositiveNumber(value: JsonValue, pointer: string, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    invalidDeclaration(pointer, `${field} must be a positive number`);
  }
}

function validateStringArray(value: JsonValue, pointer: string, field: string, allowEmpty = true): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalidDeclaration(pointer, `${field} must be an${allowEmpty ? "" : " non-empty"} array of strings`);
  }
  for (const [index, item] of value.entries()) {
    validateNonEmptyString(item, declarationPointer(pointer, index), `${field} item`);
  }
}

function validateStringMap(value: JsonValue, pointer: string, field: string): void {
  if (!isJsonRecord(value)) {
    invalidDeclaration(pointer, `${field} must be an object map`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0) {
      invalidDeclaration(declarationPointer(pointer, key), `${field} contains an empty key`);
    }
    if (typeof item !== "string") {
      invalidDeclaration(declarationPointer(pointer, key), `${field} value must be a string`);
    }
  }
}

function hasKnownKey(
  record: { readonly [key: string]: JsonValue },
  knownKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(record).some((key) => knownKeys.has(key));
}

function requireKnownKey(
  record: { readonly [key: string]: JsonValue },
  knownKeys: ReadonlySet<string>,
  pointer: string,
  field: string,
): void {
  if (!hasKnownKey(record, knownKeys)) {
    invalidDeclaration(pointer, `${field} object has no recognized declaration fields`);
  }
}

function validateHookHandler(
  value: JsonValue,
  pointer: string,
  field: string,
  nativeHost: NativeHost,
): void {
  const record = nonEmptyRecord(value, pointer, field);
  const shape = shapeFor(nativeHost);
  requireKnownKey(record, shape.hookKeys, pointer, field);

  if (record.type !== undefined) {
    validateNonEmptyString(record.type, declarationPointer(pointer, "type"), `${field}.type`);
  }
  if (record.command !== undefined) {
    validateNonEmptyString(record.command, declarationPointer(pointer, "command"), `${field}.command`);
  }
  if (record.url !== undefined) {
    validateNonEmptyString(record.url, declarationPointer(pointer, "url"), `${field}.url`);
  }
  for (const key of ["prompt", "agent", "mcp_tool", "shell", "statusMessage"] as const) {
    if (record[key] !== undefined) {
      validateNonEmptyString(record[key], declarationPointer(pointer, key), `${field}.${key}`);
    }
  }
  if (record.matcher !== undefined || record.description !== undefined) {
    for (const key of ["matcher", "description"] as const) {
      if (record[key] !== undefined) {
        validateNonEmptyString(record[key], declarationPointer(pointer, key), `${field}.${key}`);
      }
    }
  }
  for (const key of ["timeout", "timeoutMs", "timeout_ms"] as const) {
    if (record[key] !== undefined) {
      validatePositiveNumber(record[key], declarationPointer(pointer, key), `${field}.${key}`);
    }
  }
  if (record.async !== undefined) {
    validateBoolean(record.async, declarationPointer(pointer, "async"), `${field}.async`);
  }
  if (record.asyncRewake !== undefined) {
    validateBoolean(record.asyncRewake, declarationPointer(pointer, "asyncRewake"), `${field}.asyncRewake`);
  }
  if (record.args !== undefined) {
    validateStringArray(record.args, declarationPointer(pointer, "args"), `${field}.args`);
  }
  if (record.hooks !== undefined) {
    validateHookHandlers(record.hooks, declarationPointer(pointer, "hooks"), field, nativeHost);
  }

  const hasExecutableDeclaration = ["command", "url", "prompt", "agent", "mcp_tool"].some(
    (key) => record[key] !== undefined,
  );
  if (!hasExecutableDeclaration && record.hooks === undefined) {
    invalidDeclaration(pointer, `${field} handler must declare a command, URL, or nested hook list`);
  }
}

function validateHookHandlers(
  value: JsonValue,
  pointer: string,
  field: string,
  nativeHost: NativeHost,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    invalidDeclaration(pointer, `${field} event must contain a non-empty hook list`);
  }
  for (const [index, item] of value.entries()) {
    const itemPointer = declarationPointer(pointer, index);
    if (typeof item === "string") {
      validateNonEmptyString(item, itemPointer, `${field} hook path`);
    } else {
      validateHookHandler(item, itemPointer, field, nativeHost);
    }
  }
}

function validateHookEvent(value: JsonValue, pointer: string, field: string, nativeHost: NativeHost): void {
  if (typeof value === "string") {
    validateNonEmptyString(value, pointer, field);
    return;
  }
  if (Array.isArray(value)) {
    validateHookHandlers(value, pointer, field, nativeHost);
    return;
  }
  validateHookHandler(value, pointer, field, nativeHost);
}

function validateHooks(value: JsonValue, pointer: string, field: string, nativeHost: NativeHost): void {
  if (typeof value === "string") {
    validateNonEmptyString(value, pointer, field);
    return;
  }
  const events = nonEmptyRecord(value, pointer, field);
  for (const [event, declaration] of Object.entries(events)) {
    if (event.length === 0) {
      invalidDeclaration(declarationPointer(pointer, event), `${field} contains an empty event name`);
    }
    validateHookEvent(declaration, declarationPointer(pointer, event), `${field}.${event}`, nativeHost);
  }
}

const serverEndpointKeys = new Set(["command", "url", "httpUrl", "http_url", "path"]);
const oauthStringFields = [
  "clientId",
  "clientSecret",
  "authorizationUrl",
  "tokenUrl",
  "accessTokenEnvVar",
] as const;
const oauthFields = new Set<string>([...oauthStringFields, "scopes"]);
const nestedPolicyFields = new Set(["installation", "authentication"]);
const dependencyIdentityKeys = new Set([
  "name", "id", "package", "plugin", "source", "url", "path", "repo", "repository",
]);
const pluginIdentityKeys = new Set([
  "name", "id", "source", "url", "path", "repo", "repository",
]);

function validateOAuthRecord(value: JsonValue, pointer: string, field: string): void {
  const oauth = nonEmptyRecord(value, pointer, field);
  requireKnownKey(oauth, oauthFields, pointer, field);
  for (const key of oauthStringFields) {
    if (oauth[key] !== undefined) {
      validateNonEmptyString(oauth[key], declarationPointer(pointer, key), `${field}.${key}`);
    }
  }
  if (oauth.scopes !== undefined) {
    validateStringArray(oauth.scopes, declarationPointer(pointer, "scopes"), `${field}.scopes`);
  }
}

function validateNestedPolicy(value: JsonValue, pointer: string, field: string): void {
  const policy = nonEmptyRecord(value, pointer, field);
  requireKnownKey(policy, nestedPolicyFields, pointer, field);
  if (policy.installation !== undefined) {
    validateNonEmptyString(policy.installation, declarationPointer(pointer, "installation"), `${field}.installation`);
  }
  if (policy.authentication !== undefined) {
    validateNonEmptyString(policy.authentication, declarationPointer(pointer, "authentication"), `${field}.authentication`);
  }
}

function validateServerRecord(
  value: JsonValue,
  pointer: string,
  field: string,
  nativeHost: NativeHost,
): void {
  const record = nonEmptyRecord(value, pointer, field);
  requireKnownKey(record, shapeFor(nativeHost).serverKeys, pointer, field);
  if (record.command !== undefined) {
    validateNonEmptyString(record.command, declarationPointer(pointer, "command"), `${field}.command`);
  }
  for (const key of ["url", "httpUrl", "http_url", "path", "cwd", "workingDirectory", "working_directory", "type", "transport", "bearer_token_env_var"] as const) {
    if (record[key] !== undefined) {
      validateNonEmptyString(record[key], declarationPointer(pointer, key), `${field}.${key}`);
    }
  }
  if (record.args !== undefined) {
    validateStringArray(record.args, declarationPointer(pointer, "args"), `${field}.args`);
  }
  for (const key of ["env", "headers", "http_headers"] as const) {
    if (record[key] !== undefined) {
      validateStringMap(record[key], declarationPointer(pointer, key), `${field}.${key}`);
    }
  }
  for (const key of ["enabledTools", "disabledTools", "enabled_tools", "disabled_tools"] as const) {
    if (record[key] !== undefined) {
      validateStringArray(record[key], declarationPointer(pointer, key), `${field}.${key}`);
    }
  }
  for (const key of ["timeout", "startupTimeout", "toolTimeout", "startup_timeout_sec", "tool_timeout_sec"] as const) {
    if (record[key] !== undefined) {
      validatePositiveNumber(record[key], declarationPointer(pointer, key), `${field}.${key}`);
    }
  }
  if (record.required !== undefined) {
    validateBoolean(record.required, declarationPointer(pointer, "required"), `${field}.required`);
  }
  if (record.oauth !== undefined) {
    validateOAuthRecord(record.oauth, declarationPointer(pointer, "oauth"), `${field}.oauth`);
  }
  if (!Object.keys(record).some((key) => serverEndpointKeys.has(key))) {
    invalidDeclaration(pointer, `${field} server must declare a command, URL, path, or HTTP endpoint`);
  }
}

function validateServerMap(
  value: JsonValue,
  pointer: string,
  field: string,
  nativeHost: NativeHost,
): void {
  if (typeof value === "string") {
    validateNonEmptyString(value, pointer, field);
    return;
  }
  const servers = nonEmptyRecord(value, pointer, field);
  for (const [key, item] of Object.entries(servers)) {
    const itemPointer = declarationPointer(pointer, key);
    if (key.length === 0) {
      invalidDeclaration(itemPointer, `${field} contains an empty server key`);
    }
    if (typeof item === "string") {
      validateNonEmptyString(item, itemPointer, `${field} server path`);
    } else {
      validateServerRecord(item, itemPointer, field, nativeHost);
    }
  }
}

function validateSettingObject(
  value: JsonValue,
  pointer: string,
  field: string,
  nativeHost: NativeHost,
): void {
  if (typeof value === "string") {
    validateNonEmptyString(value, pointer, field);
    return;
  }
  const settings = nonEmptyRecord(value, pointer, field);
  requireKnownKey(settings, shapeFor(nativeHost).settingsKeys, pointer, field);
  for (const key of ["path", "scope"] as const) {
    if (settings[key] !== undefined) {
      validateNonEmptyString(settings[key], declarationPointer(pointer, key), `${field}.${key}`);
    }
  }
  if (settings.enabled !== undefined) {
    validateBoolean(settings.enabled, declarationPointer(pointer, "enabled"), `${field}.enabled`);
  }
  for (const key of ["env", "defaults", "configuration", "settings", "userConfig", "user_config"] as const) {
    if (settings[key] !== undefined && !isJsonRecord(settings[key])) {
      invalidDeclaration(declarationPointer(pointer, key), `${field}.${key} must be an object`);
    }
  }
}

function validateDependencyRecord(
  value: JsonValue,
  pointer: string,
  field: string,
  nativeHost: NativeHost,
  identityProvidedByKey = false,
): void {
  const record = nonEmptyRecord(value, pointer, field);
  const knownKeys = field === "plugins" ? shapeFor(nativeHost).pluginKeys : shapeFor(nativeHost).dependencyKeys;
  requireKnownKey(record, knownKeys, pointer, field);
  const identityKeys = field === "plugins" ? pluginIdentityKeys : dependencyIdentityKeys;
  if (!identityProvidedByKey && !hasKnownKey(record, identityKeys)) {
    invalidDeclaration(pointer, `${field} record must identify its dependency or plugin`);
  }
  for (const key of [
    "name", "id", "package", "plugin", "source", "url", "path", "repo", "repository",
    "registry", "version", "selector", "constraint", "range", "ref", "sha",
  ] as const) {
    if (record[key] !== undefined) {
      validateNonEmptyString(record[key], declarationPointer(pointer, key), `${field}.${key}`);
    }
  }
  for (const key of ["optional", "strict"] as const) {
    if (record[key] !== undefined) {
      validateBoolean(record[key], declarationPointer(pointer, key), `${field}.${key}`);
    }
  }
  if (record.platform !== undefined) {
    const platformPointer = declarationPointer(pointer, "platform");
    if (typeof record.platform === "string") {
      validateNonEmptyString(record.platform, platformPointer, `${field}.platform`);
    } else {
      validateStringArray(record.platform, platformPointer, `${field}.platform`, false);
    }
  }
  if (record.dependencies !== undefined) {
    validateDependencyDeclaration(record.dependencies, declarationPointer(pointer, "dependencies"), "dependencies", nativeHost);
  }
  if (record.policy !== undefined) {
    validateNestedPolicy(record.policy, declarationPointer(pointer, "policy"), `${field}.policy`);
  }
}

function validateDependencyItem(
  value: JsonValue,
  pointer: string,
  field: string,
  nativeHost: NativeHost,
  identityProvidedByKey = false,
): void {
  if (typeof value === "string") {
    validateNonEmptyString(value, pointer, field);
    return;
  }
  if (isJsonRecord(value)) {
    validateDependencyRecord(value, pointer, field, nativeHost, identityProvidedByKey);
    return;
  }
  invalidDeclaration(pointer, `${field} item must be a non-empty string or recognized object record`);
}

function validateDependencyDeclaration(
  value: JsonValue,
  pointer: string,
  field: string,
  nativeHost: NativeHost,
): void {
  if (typeof value === "string") {
    validateNonEmptyString(value, pointer, field);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      invalidDeclaration(pointer, `${field} must not be empty`);
    }
    for (const [index, item] of value.entries()) {
      validateDependencyItem(item, declarationPointer(pointer, index), field, nativeHost);
    }
    return;
  }
  const record = nonEmptyRecord(value, pointer, field);
  const knownKeys = field === "plugins" ? shapeFor(nativeHost).pluginKeys : shapeFor(nativeHost).dependencyKeys;
  if (hasKnownKey(record, knownKeys)) {
    validateDependencyRecord(record, pointer, field, nativeHost);
    return;
  }
  // A map keyed by package/plugin name is a supported foreign shorthand. Its
  // keys are dynamic, but every value still has a concrete string or record
  // shape; `{name: {mystery: true}}` therefore fails at the nested record.
  for (const [key, item] of Object.entries(record)) {
    const itemPointer = declarationPointer(pointer, key);
    if (key.length === 0) {
      invalidDeclaration(itemPointer, `${field} contains an empty dependency key`);
    }
    validateDependencyItem(item, itemPointer, field, nativeHost, true);
  }
}

/**
 * Validate known declarations at the format boundary. The host-specific shape
 * registries deliberately recognize documented fields while allowing extra
 * fields on an otherwise anchored record, so forward-compatible foreign data
 * is retained without allowing empty or unknown-only runtime records through.
 */
export function validateKnownDeclaration(
  nativeHost: NativeHost,
  field: MarketplaceEntryDeclarationField,
  value: JsonValue,
  pointer: string,
): void {
  JsonValueSchema.parse(value);
  switch (field) {
    case "skills":
    case "commands":
    case "agents":
    case "outputStyles":
      validateStringList(value, pointer, field);
      return;
    case "hooks":
      validateHooks(value, pointer, field, nativeHost);
      return;
    case "mcpServers":
    case "lspServers":
      validateServerMap(value, pointer, field, nativeHost);
      return;
    case "settings":
      validateSettingObject(value, pointer, field, nativeHost);
      return;
    case "dependencies":
    case "plugins":
      validateDependencyDeclaration(value, pointer, field, nativeHost);
      return;
    default:
      throw new Error(`Unhandled marketplace declaration field: ${field}`);
  }
}

export function collectEntryDeclarations(
  entry: { readonly [key: string]: JsonValue },
  nativeHost: NativeHost,
  path: string,
  entryPointer: string,
): Array<{
  readonly nativeHost: NativeHost;
  readonly category: MarketplaceEntryDeclaration["category"];
  readonly field: MarketplaceEntryDeclarationField;
  readonly declaration: Claimed<JsonValue>;
}> {
  const declarations: Array<{
    readonly nativeHost: NativeHost;
    readonly category: MarketplaceEntryDeclaration["category"];
    readonly field: MarketplaceEntryDeclarationField;
    readonly declaration: Claimed<JsonValue>;
  }> = [];
  for (const field of Object.keys(MarketplaceEntryDeclarationRegistry) as MarketplaceEntryDeclarationField[]) {
    if (!own(entry, field)) {
      continue;
    }
    const value = entry[field];
    if (value === undefined) {
      throw entryError("ENTRY_INVALID", `${entryPointer}/${jsonPointer(field).slice(1)}`, `${field} is invalid`);
    }
    const pointer = `${entryPointer}/${jsonPointer(field).slice(1)}`;
    validateKnownDeclaration(nativeHost, field, value, pointer);
    declarations.push({
      nativeHost,
      category: MarketplaceEntryDeclarationRegistry[field].category,
      field,
      declaration: claimAt(value, nativeHost, path, pointer, value),
    });
  }
  return declarations;
}

export function entryPointerPath(entryPointer: string, field: string): string {
  return `${entryPointer}/${jsonPointer(field).slice(1)}`;
}
