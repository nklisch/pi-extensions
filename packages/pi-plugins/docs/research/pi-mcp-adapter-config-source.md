# Research: `pi-mcp-adapter` configuration-source integration

**Evidence date:** 2026-07-16

**Upstream examined:** `nicobailon/pi-mcp-adapter` `main` and npm `pi-mcp-adapter@2.11.0`

**Pinned source revision:** [`82724dccc13a49310530898f922bafff12b7f3fe`](https://github.com/nicobailon/pi-mcp-adapter/commit/82724dccc13a49310530898f922bafff12b7f3fe)

**Commissioning feature:** `epic-mcp-runtime-integration-config-source-bridge`

## Executive finding

`pi-mcp-adapter@2.11.0` and upstream `main` do **not** expose a supported programmatic configuration-source API that satisfies Plugin Host. The package has no `exports`, `main`, or `module` entry and advertises only Pi's TypeScript extension entry, `./index.ts`. Its default extension synchronously reads file configuration and metadata cache during extension construction, then registers direct/proxy Pi tools. At `session_start` it reads the files again, creates the manager and lifecycle, registers servers, and can connect bootstrap, eager, or keep-alive servers. [S1][S3][S4][S5]

The supported path is therefore:

1. contribute the narrow source contract upstream and consume the first release containing it;
2. if upstream cannot land it in the required delivery window, publish a narrowly maintained MIT fork exposing the **same** contract;
3. do not use deep imports, monkeypatching, temporary/global settings mutation, or an MCP SDK reimplementation.

**Blocker status:** production integration is externally blocked today. There is no qualifying released upstream API and this project declares no qualifying maintained fork. Portable Plugin Host ports, source/status/capability schemas, package-independent mapping, and fakes can land now. A production adapter and an end-to-end activation claim cannot land honestly until an upstream release or maintained fork implements the minimum contract below.

## Project constraints used for evaluation

The recommendation is evaluated against the current project foundation, not generic package convenience:

- MCP transport, authentication, discovery, elicitation, sampling, and process lifecycle remain owned by a dedicated MCP runtime; Plugin Host must not reimplement them (`docs/ARCHITECTURE.md`).
- Generated runtime projections are derived and replaceable, not settings or authoritative state (`docs/ARCHITECTURE.md`).
- Plugin-scoped identity must survive inspection and exact removal, including overlapping native server names (`docs/SPEC.md`, `docs/COMPATIBILITY.md`).
- Sensitive values resolve only at the immediate launch/connection boundary and do not enter projections, status, provenance, logs, or files (`epic-mcp-runtime-integration`).
- Startup remains local/offline-safe; source registration proves local inventory, not remote reachability (`epic-mcp-runtime-integration`).
- Runtime capability facts feed the existing `RuntimeCapabilityProbe`; the adapter does not create component verdicts (`src/application/ports/runtime-capability-probe.ts`).

## Package and maintenance facts

### Version, release, and license

- npm's `latest` distribution tag is **2.11.0**. npm records publication at `2026-07-03T16:59:56.410Z`, with `gitHead` `82724dccc13a49310530898f922bafff12b7f3fe`. [S1]
- GitHub's latest release is `v2.11.0`, published `2026-07-03T17:01:25Z`; the tag points to the same commit. At the evidence date, upstream `main` also points to that commit, so there is no unreleased source API on `main`. [S2][S22]
- The package and repository are **MIT** licensed. A narrow fork is legally permitted provided the copyright and license notice are retained. [S1][S14]

### Package shape and runtime declarations

The 2.11.0 npm tarball contains 48 entries, is 1,335,260 bytes compressed and 1,921,119 bytes unpacked. It ships `index.ts` and the other TypeScript extension modules directly, plus `cli.js`, documentation, the MIT license, UI assets, and the bundled app bridge. It does not ship compiled declarations or a compiled library entry. [S1][S15]

The package manifest has:

```json
{
  "type": "module",
  "bin": { "pi-mcp-adapter": "cli.js" },
  "pi": { "extensions": ["./index.ts"] }
}
```

It has **no** `exports`, `main`, `module`, or `engines` field. Consequently:

- the supported package shape is a Pi extension plus CLI, not a documented library API;
- deep subpath imports happen to be reachable under Node's no-`exports` behavior, but are unversioned implementation access, not a supported contract;
- the package does not state a Node minimum. The npm publisher used Node 24.18.0, but publish-tool metadata is not a runtime guarantee. [S1][S3]

Version declarations relevant to Pi are:

- runtime dependencies `@earendil-works/pi-ai` and `@earendil-works/pi-tui` at `^0.74.0`;
- development dependency `@earendil-works/pi-coding-agent` at `^0.79.1`;
- MCP SDK dependency `@modelcontextprotocol/sdk` at `^1.25.1`;
- `zod` peer range `^3.25.0 || ^4.0.0`.

The coding-agent package is imported by extension source but is not declared as a dependency or peer; it is supplied by Pi. Version 0.79.1 declares Node `>=22.19.0`, while the 0.74.0 Pi AI/TUI packages declare Node `>=20.0.0`. Plugin Host's Node 24 baseline is compatible with those declared floors, but upstream itself does not promise a complete Pi or Node support matrix. [S1][S16]

### Maintenance and adoption health

The project is active rather than abandoned:

- npm records 36 versions from 2026-01-19 through 2026-07-03, including monthly or faster releases in the recent sequence. [S1]
- GitHub exposes 43 open issues and 27 open pull requests at the evidence date, alongside 76 closed pull requests. This is an active project with a material review backlog, not evidence that a proposed API will land on a particular schedule. [S17]
- npm recorded 129,186 downloads for 2026-06-16 through 2026-07-15. [S18]
- v2.11.0 incorporated multiple community fixes and features, including cancellation propagation and timeout handling. [S2]

**Health assessment:** suitable upstream target; release timing for a new public source lifecycle remains external and uncommitted.

## Verified current API surface

### Existing signatures relevant to integration

The following are actual 2.11.0 source signatures:

```ts
// index.ts
export default function mcpAdapter(pi: ExtensionAPI): void;

// config.ts
export function loadMcpConfig(
  overridePath?: string,
  cwd = process.cwd(),
): McpConfig;

// init.ts
export async function initializeMcp(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<McpExtensionState>;

// server-manager.ts (internal module)
export class McpServerManager {
  connect(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
  ): Promise<ServerConnection>;
  close(name: string): Promise<void>;
  closeAll(): Promise<void>;
  getConnection(name: string): ServerConnection | undefined;
  getAllConnections(): Map<string, ServerConnection>;
}
```

`ServerConnection` is a non-exported interface. `McpServerManager`, `McpLifecycleManager`, `loadMcpConfig`, and related types are source-module exports, but the package manifest does not designate any of them as supported package exports. [S3][S4][S5][S6]

### Required source contract: supported or absent

| Required behavior | 2.11.0 / `main` finding | Evidence |
|---|---|---|
| Supply a programmatic source before Pi tool registration | **Absent.** The default extension loads files/cache and immediately registers direct/proxy tools. | [S3] |
| Stable source identity and provenance | **Absent as a runtime source contract.** `ConfigSourceSpec` is a private fixed-file descriptor; exported `ServerProvenance` is path/kind/import metadata keyed by merged server name. | [S4][S7] |
| Atomic source replacement | **Absent.** No source registry or compare-and-replace operation exists. | [S3][S4][S6] |
| Exact source removal | **Absent.** The manager can close one server by merged name, not remove a source and its complete owned inventory. | [S6] |
| Source/status inspection | **Absent as supported API.** `/mcp` and proxy status inspect extension-internal server state; no redacted, source-qualified public status exists. | [S6][S8] |
| Runtime capability reporting | **Absent.** MCP client capabilities are built internally from UI/sampling configuration; no public complete runtime capability snapshot is exposed. | [S6] |
| Late value callbacks | **Absent.** Static strings are interpolated from process-global environment at connection creation. No caller callback receives source/server context and cancellation. | [S6][S9] |
| Cancellation for source registration/replacement/removal | **Absent.** File loading and server registration are synchronous. Connection, resource, and tool calls accept signals, which is useful but not a source-lifecycle API. | [S4][S5][S6][S10] |

**Answer to the core API question:** no. Neither npm 2.11.0 nor `main` exposes the required supported programmatic configuration-source contract.

## Current load and registration timing

### 1. Extension construction

When Pi calls the default extension factory, it immediately:

1. reads `--mcp-config` directly from `process.argv` using `getConfigPathFromArgv()`;
2. calls synchronous `loadMcpConfig(earlyConfigPath)` using the process working directory;
3. loads the agent-wide metadata cache;
4. derives direct tools from that config/cache and `MCP_DIRECT_TOOLS`;
5. registers every resolved direct Pi tool;
6. registers the proxy `mcp` tool when its conditions hold;
7. only then registers the formal Pi `mcp-config` flag and session handlers. [S3][S9]

Direct-tool shape is therefore fixed from construction-time files and cache. A later source cannot participate before registration through a supported API.

### 2. File discovery and merge behavior

`loadMcpConfig` synchronously discovers and merges, in order:

1. `~/.config/mcp/mcp.json`;
2. the Pi-global path (`<agent-dir>/mcp.json`, or the override path);
3. project `.mcp.json`;
4. project `.pi/mcp.json`.

Configured host imports are expanded while each layer is merged. Later server fields override earlier fields by server name. The result is one flat `mcpServers` map. [S4]

The `--mcp-config` path replaces only the Pi-global layer's path. It does **not** disable standard global discovery, project discovery, `.pi/mcp.json`, or configured imports. Supplying a generated file therefore does not create an isolated source.

### 3. `session_start`

At `session_start`, the extension tears down prior session state and OAuth state, initializes OAuth, then calls `initializeMcp(pi, ctx)`. That function obtains `pi.getFlag("mcp-config")` and calls `loadMcpConfig(configPath, ctx.cwd)` a second time. [S3][S5]

Construction-time tool registration can therefore be based on a different working directory or flag observation than session-time runtime initialization. This is especially relevant to SDK embedding, where setting a Pi flag need not mean mutating `process.argv` before extension construction.

### 4. Manager, lifecycle, and cache registration

`initializeMcp` constructs `McpServerManager(ctx.cwd)` and `McpLifecycleManager`, applies timeout/sampling/elicitation settings, and registers every merged server definition with the lifecycle. Valid metadata cache entries reconstruct tool metadata without connecting. [S5]

### 5. Server startup

- If the metadata cache file does not exist, `bootstrapAll` selects **all** configured servers for connection, including otherwise-lazy servers.
- With an existing cache, `keep-alive` and `eager` servers connect at startup.
- Configured direct-tool servers missing valid cache metadata can trigger an additional connection/bootstrap pass.
- Health checks then reconnect keep-alive servers and close idle non-keep-alive servers. [S5][S11]

The README's “lazy by default” description is qualified by these first-run and direct-tool bootstrap paths. [S12]

## Why file or flag injection is insufficient

A generated config file plus `--mcp-config` can make servers visible, but it is not equivalent to the required behavior:

1. **Not isolated:** standard global/project files and imports still merge around the override file. A user's server can enter the supposedly plugin-owned runtime, and a project override can replace a plugin server by name. [S4]
2. **No source identity:** merge collapses ownership into server names. Provenance is path-oriented and is used for UI write-back, not exact lifecycle authority. [S7]
3. **Wrong registration boundary:** direct/proxy tools are registered before `session_start` from construction-time file/cache state. SDK flags and session-derived values arrive too late unless process-global arguments and files are manipulated before extension construction. [S3][S13]
4. **No atomic replacement/removal:** file replacement plus Pi reload cannot ask the adapter to validate a complete source, retain the old source on failure, remove only one source, or report exact replacement evidence.
5. **Behavior changes:** changing a shared/global/project file changes the user's native adapter configuration and precedence, not merely Plugin Host's derived projection. `config.ts` contains explicit write paths for UI changes. [S4][S7]
6. **Unsafe late values:** process environment interpolation occurs when the manager creates a connection, but `process.env` is process-global and carries neither plugin/source identity nor callback-scoped disposal. It is not suitable for concurrent plugin/session secret custody. [S6][S9]
7. **Cache collisions:** metadata is keyed by merged server name in one agent-wide cache, so source-qualified identity is lost before direct-tool registration. [S5]

These are semantic differences, not packaging inconvenience. File injection would violate the project's no-settings-mutation, derived-projection, exact-removal, and late-secret boundaries.

## Disconfirming evidence examined

Two upstream artifacts show recognized demand for programmatic configuration:

- Open issue [#85](https://github.com/nicobailon/pi-mcp-adapter/issues/85), created 2026-05-06, requests session-scoped programmatic config or a `configProvider` and explicitly identifies temporary files/process arguments as the current workaround. It remains open. [S13]
- Open PR [#56](https://github.com/nicobailon/pi-mcp-adapter/pull/56), created 2026-04-25, proposes `registerMcpServerProvider(pi, provider)` with `{ source, priority?, servers }`. It remains unmerged, reports a dirty merge state, and is based on v2.6.0-era source. [S19][S20]

PR #56 is useful upstream precedent but does not disconfirm the central finding because it is not in `main` or npm 2.11.0. Its proposed API is also insufficient for Plugin Host:

- collection is synchronous and returns a flat server map;
- `source` is attached to per-server write provenance, not a first-class source lifecycle identity;
- no atomic replace, remove, redacted status, capability report, late value callback, or cancellation exists;
- direct-tool changes for extension servers are written into the user config;
- tools are registered only once after collection, so later source replacement is not modeled. [S20]

No fetched upstream issue, PR, `main` source, or package metadata exposed the complete required contract.

## Contradictions and tensions

- **“Lazy by default” versus startup behavior:** README describes lazy default operation, while `initializeMcp` connects every server when the metadata cache is absent and may connect direct-tool servers when cache entries are missing. Both are true under different cache conditions; Plugin Host must treat registration status separately from remote connection status. [S5][S12]
- **Programmatic-provider proposal versus current package API:** PR #56 documents a provider subpath, while npm 2.11.0 has no `exports` and no `providers.ts`. The PR is open and unmerged; the release is authoritative for current consumption. [S1][S19][S20]
- **Late environment interpolation versus late value custody:** 2.11.0 resolves environment placeholders at connection creation, but only through process-global environment and static definitions. This is later than file parsing, yet it is not the source-scoped callback and disposal contract required by Plugin Host. [S6][S9]

## Options evaluated

| Option | License | Fit | Availability now | Decision |
|---|---|---:|---:|---|
| A. Upstream API contribution, then consume release | MIT | 5/5 | 1/5 | **Preferred**; externally blocked until release |
| B. Narrow maintained fork/package with identical contract | MIT, retain notice | 4/5 | 1/5 | Approved fallback only when upstream timing is insufficient |
| C. Deep imports, monkeypatching, file/global settings mutation | Underlying package MIT, but unsupported API | 1/5 | 3/5 | Reject |
| D. Reimplement runtime on `@modelcontextprotocol/sdk` | SDK MIT | 2/5 | 2/5 | Reject |

### A. Upstream contribution and released API

**Advantages**

- keeps transport/auth/discovery/lifecycle fixes in the active upstream;
- avoids permanent divergence around a fast-moving MCP and Pi surface;
- gives the source contract an explicit exported package boundary;
- aligns with existing upstream demand in issue #85 and PR #56.

**Risks**

- maintainer review and release timing are outside this project;
- PR #56 cannot simply be consumed: it is incomplete for this contract and stale against current source;
- source lifecycle and direct-tool timing touch central extension construction and session lifecycle.

**Decision:** submit a small, contract-focused upstream change and consume only a release that exposes the complete minimum contract. Do not code against an open PR SHA as the production dependency.

### B. Narrow maintained fork/package

A fork is legally viable under MIT. It should start from the exact current release commit, preserve upstream history/license, use a clearly scoped package name, track upstream releases, and carry only the public programmatic-source contract plus tests. The package must expose the same API intended for upstream so Plugin Host contains no upstream/fork branches.

**Risks**

- security and protocol fixes must be rebased promptly;
- package provenance and ownership become this project's responsibility;
- divergence can expand if the fork changes transport/policy rather than only the source seam.

**Decision:** use only if upstream cannot land in the required window. No qualifying fork exists in this repo today, so this fallback is not yet consumable.

### C. Deep imports, monkeypatching, files, or global settings

Deep imports can reach shipped `.ts` modules because 2.11.0 has no `exports`, but private closures hold construction-time state and package updates can move any source file or signature without semver protection. Monkeypatching cannot reliably insert a source before direct-tool registration. Generated files/global environment/settings lose ownership and atomicity and alter user behavior.

**Decision:** reject. This option violates explicit project constraints even if a prototype appears to work.

### D. Reimplement MCP with the SDK

`@modelcontextprotocol/sdk@1.25.1` is MIT and supports Node `>=18`; 2.11.0 depends on it. [S21] Building directly on it would nevertheless make Plugin Host own transport selection, OAuth, discovery pagination, sampling, elicitation, UI/resource behavior, caching, retries, cancellation, and process lifecycle already implemented by the adapter.

**Decision:** reject. It duplicates a dedicated runtime and creates a larger, less maintainable compatibility surface.

## Exact minimum upstream/fork contract

Names may be adjusted in upstream review, but the following semantics are the minimum acceptable ABI. It must be a documented `exports` subpath, not a deep import.

```ts
export interface McpSourceIdentity {
  /** Stable opaque key; removal and replacement use this, never server names. */
  readonly id: string;
  readonly scope: string;
  readonly plugin: string;
  readonly revision: string;
  readonly projectionDigest: string;
}

export interface McpSourceServer {
  readonly transport: "stdio" | "streamable-http";
  /** Secret-free structural options: lifecycle, timeouts, filters, auth mode. */
  readonly options: Readonly<Record<string, unknown>>;
  /** Secret-free templates/opaque references; never expanded in source status. */
  readonly launchTemplate: Readonly<Record<string, unknown>>;
}

export interface McpConfigSource {
  readonly schemaVersion: 1;
  readonly identity: McpSourceIdentity;
  /** Structurally validated, secret-free server declarations. */
  readonly servers: Readonly<Record<string, McpSourceServer>>;
}

export interface McpLaunchValueRequest {
  readonly source: McpSourceIdentity;
  readonly serverKey: string;
  readonly transport: "stdio" | "streamable-http";
}

export interface McpLaunchValues {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly bearerToken?: string;
}

export interface McpLaunchValueProvider {
  resolve(
    request: McpLaunchValueRequest,
    signal: AbortSignal,
  ): Promise<McpLaunchValues>;
  dispose?(values: McpLaunchValues): void | Promise<void>;
}

export interface McpSourceStatus {
  readonly identity: McpSourceIdentity;
  readonly state: "registered" | "replacing" | "removing" | "failed";
  readonly servers: readonly {
    readonly key: string;
    readonly state: "registered" | "idle" | "connecting" | "connected" | "needs-auth" | "failed";
    readonly toolCount?: number;
    readonly errorCode?: string;
  }[];
}

export interface McpRuntimeCapabilities {
  readonly schemaVersion: 1;
  readonly sourceLifecycle: {
    readonly atomicReplace: true;
    readonly exactRemove: true;
    readonly inspect: true;
    readonly cancellable: true;
    readonly lateLaunchValues: true;
  };
  readonly transports: {
    readonly stdio: boolean;
    readonly streamableHttp: boolean;
    readonly legacySse: boolean;
    readonly websocket: boolean;
  };
  readonly oauth: {
    readonly authorizationCode: boolean;
    readonly clientCredentials: boolean;
  };
  readonly features: {
    readonly sampling: boolean;
    readonly elicitationForm: boolean;
    readonly elicitationUrl: boolean;
    readonly toolApproval: boolean;
    readonly resources: boolean;
  };
}

export interface McpProgrammaticRuntime {
  capabilities(): McpRuntimeCapabilities;
  replaceSource(
    source: McpConfigSource,
    options: {
      expectedProjectionDigest?: string;
      launchValues: McpLaunchValueProvider;
    },
    signal: AbortSignal,
  ): Promise<McpSourceStatus>;
  removeSource(identity: McpSourceIdentity, signal: AbortSignal): Promise<void>;
  inspectSource(identity: McpSourceIdentity, signal: AbortSignal): Promise<McpSourceStatus | undefined>;
  inspectSources(signal: AbortSignal): Promise<readonly McpSourceStatus[]>;
}

export function createMcpAdapter(options: {
  /** Collected before this adapter registers any Pi tools. */
  initialSources?: readonly {
    source: McpConfigSource;
    launchValues: McpLaunchValueProvider;
  }[];
  /** File discovery remains the default for ordinary standalone users. */
  fileDiscovery?: "enabled" | "disabled";
}): {
  extension: (pi: ExtensionAPI) => void;
  runtime: McpProgrammaticRuntime;
};
```

### Required semantics beyond TypeScript shape

1. `initialSources` are structurally validated and installed before direct/proxy tool registration. With `fileDiscovery: "disabled"`, no global/project/import file is read.
2. Source identity is retained in every internal server/tool/cache key. Same native server names in different sources cannot collide.
3. `replaceSource` is all-or-nothing for one source. Invalid new input leaves the old source and processes usable. `expectedProjectionDigest` provides stale-writer detection.
4. `removeSource` is idempotent and removes/closes only the exact source's servers, tools, metadata, and processes.
5. Inspection is local, redacted, JSON-safe, source-qualified, and never contains definitions after expansion, credentials, native causes, or callback results.
6. Capability reporting is complete and environment-aware. In particular, URL elicitation can be unavailable without TUI, and automatic legacy-SSE fallback must not be reported as Streamable HTTP equivalence.
7. `McpLaunchValueProvider.resolve` runs only immediately before standard-I/O launch or HTTP connection. Values are not cached, serialized, logged, included in status, or passed through metadata. `dispose` runs on success, failure, and cancellation.
8. Every async source lifecycle and launch operation honors the supplied `AbortSignal`. Cancellation never converts a partial replacement into success.
9. Registration proves local source/inventory acceptance only. Eager connection health is a separate server status and cannot make offline startup source registration fail globally.
10. The default extension and file behavior remain available for existing users; Plugin Host uses the programmatic export and disables file discovery for its owned runtime instance.

This is intentionally narrower than exposing `McpServerManager`: Plugin Host needs source lifecycle and facts, not transport internals.

## What can proceed before the external package exists

The following work is package-independent and can be implemented now:

- a Plugin Host `McpRuntimePort`/bridge interface expressed only in project types;
- schemas for source identity, secret-free server projection, capability facts, and redacted status;
- mapping from adapter capability facts into the existing `RuntimeCapabilityProbe` registry;
- fake runtime and contract tests for exact source identity, compare-and-replace, idempotent removal, cancellation, redaction, and rollback evidence;
- composition selection that fails closed with `pi.mcp.runtime` unavailable when no qualifying package is present;
- an upstream/fork conformance suite that can later be run against either package without changing application/domain code.

The following work is genuinely blocked:

- a production adapter importing a supported `pi-mcp-adapter` programmatic API;
- truthful production availability for `pi.mcp.runtime` and dependent capability facts;
- end-to-end proof that a Plugin Host source is installed before Pi tool registration;
- production atomic replace/remove and source-qualified status against the real MCP process manager;
- production callback-scoped secret delivery through the adapter's immediate launch boundary.

Landing only the portable layer must not mark the feature complete or claim MCP activation works.

## Recommendation and checkpoint decision

Proceed upstream-first with the exact narrow contract above. Use issue #85 and PR #56 as evidence and prior art, but propose a current v2.11-based source lifecycle rather than extending the stale provider patch. Require a published upstream version before selecting the production dependency. If upstream cannot release in time, create and publish a narrowly maintained MIT fork with the identical exported contract and conformance suite.

Until one of those packages exists, continue only the portable bridge/contracts/fakes work and report the production dependency as **externally blocked**. Do not mutate settings/files, monkeypatch internals, depend on deep imports, or reimplement MCP.

## Sources

All external claims above are bound to sources fetched on 2026-07-16.

- **[S1]** [npm registry package metadata for `pi-mcp-adapter`](https://registry.npmjs.org/pi-mcp-adapter) — latest tag, version history/times, 2.11.0 license, dependencies, publish metadata, tarball metadata, and missing package entry/engine fields.
- **[S2]** [GitHub release `v2.11.0`](https://github.com/nicobailon/pi-mcp-adapter/releases/tag/v2.11.0) — release date and change set.
- **[S3]** [`index.ts` at 2.11.0](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/index.ts#L15-L158) — construction-time config/cache reads, tool registration, flag registration, and `session_start`.
- **[S4]** [`config.ts` at 2.11.0](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/config.ts#L8-L270) — fixed file sources, synchronous discovery, merge order, private `ConfigSourceSpec`.
- **[S5]** [`init.ts` at 2.11.0](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/init.ts#L33-L225) — second config load, manager/lifecycle setup, cache behavior, startup/bootstrap connections.
- **[S6]** [`server-manager.ts` at 2.11.0](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/server-manager.ts#L33-L441) — internal manager API, transports, capabilities, signals, status and close behavior.
- **[S7]** [`config.ts` provenance/write logic](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/config.ts#L605-L677) — server-name/path provenance and settings write-back.
- **[S8]** [`commands.ts` status implementation](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/commands.ts#L20-L64) — command/UI status rather than source-qualified package API.
- **[S9]** [`utils.ts` argument and environment interpolation](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/utils.ts#L54-L94) — `process.argv`, `process.env`, headers and bearer resolution helpers.
- **[S10]** [`abort.ts` at 2.11.0](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/abort.ts) — existing request cancellation helper.
- **[S11]** [`lifecycle.ts` at 2.11.0](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/lifecycle.ts) — server-name lifecycle registration, health checks, and shutdown.
- **[S12]** [2.11.0 README configuration/lifecycle documentation](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/README.md#l39-l70) — documented files, precedence, and lazy behavior.
- **[S13]** [Upstream issue #85](https://github.com/nicobailon/pi-mcp-adapter/issues/85) — open request for programmatic session-scoped configuration and current file workaround.
- **[S14]** [MIT license at the pinned commit](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/LICENSE) — fork/modification terms.
- **[S15]** [npm 2.11.0 tarball](https://registry.npmjs.org/pi-mcp-adapter/-/pi-mcp-adapter-2.11.0.tgz) — verified published package contents.
- **[S16]** npm metadata for [`@earendil-works/pi-coding-agent@0.79.1`](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/0.79.1), [`pi-ai@0.74.0`](https://registry.npmjs.org/@earendil-works%2fpi-ai/0.74.0), and [`pi-tui@0.74.0`](https://registry.npmjs.org/@earendil-works%2fpi-tui/0.74.0) — Pi package Node engines and licenses.
- **[S17]** GitHub searches for [open issues](https://api.github.com/search/issues?q=repo%3Anicobailon%2Fpi-mcp-adapter+is%3Aissue+is%3Aopen), [open pull requests](https://api.github.com/search/issues?q=repo%3Anicobailon%2Fpi-mcp-adapter+is%3Apr+is%3Aopen), and [closed pull requests](https://api.github.com/search/issues?q=repo%3Anicobailon%2Fpi-mcp-adapter+is%3Apr+is%3Aclosed) — activity/backlog counts at the evidence date.
- **[S18]** [npm last-month download API](https://api.npmjs.org/downloads/point/2026-06-16:2026-07-15/pi-mcp-adapter) — adoption snapshot.
- **[S19]** [Upstream PR #56](https://github.com/nicobailon/pi-mcp-adapter/pull/56) and its [GitHub API record](https://api.github.com/repos/nicobailon/pi-mcp-adapter/pulls/56) — open extension-contributed-provider proposal, head/base revisions, and merge state.
- **[S20]** [PR #56 provider source at head `79c9554`](https://github.com/titouanmathis/pi-mcp-adapter/blob/79c9554bc3c02c95fba0a85c9f5a84ce353fcacb/providers.ts) and [config integration](https://github.com/titouanmathis/pi-mcp-adapter/blob/79c9554bc3c02c95fba0a85c9f5a84ce353fcacb/config.ts) — proposed signatures and limitations.
- **[S21]** [npm registry metadata for `@modelcontextprotocol/sdk@1.25.1`](https://registry.npmjs.org/@modelcontextprotocol/sdk/1.25.1) — SDK license, Node engine, and package API.
- **[S22]** [GitHub `main` commit API](https://api.github.com/repos/nicobailon/pi-mcp-adapter/commits/main) — upstream `main` revision at the evidence date.
