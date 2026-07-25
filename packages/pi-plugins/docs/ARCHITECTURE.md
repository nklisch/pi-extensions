# Pi Plugin Host Architecture

## System context

Pi Plugin Host is a Pi package and extension that consumes Claude Code and
OpenAI Codex plugin marketplaces as foreign package formats.

```text
┌───────────────────────────────┐
│ Git or npm sources            │
│                               │
│ Marketplace catalog           │
│ Plugin manifests              │
│ Skills / hooks / MCP config   │
└───────────────┬───────────────┘
                │ untrusted input
                ▼
┌───────────────────────────────┐
│ Pi Plugin Host                │
│                               │
│ Parse → normalize → validate  │
│ → trust → stage → activate    │
└───────┬──────────┬────────────┘
        │          │
        ▼          ▼
┌─────────────┐  ┌────────────────┐
│ Pi runtime  │  │ Local state     │
│             │  │                 │
│ Skills      │  │ Catalogs        │
│ Hooks       │  │ Revisions       │
│ MCP tools   │  │ Trust and data  │
└─────────────┘  └────────────────┘
```

Claude Code and Codex are specification sources and optional adoption sources.
They are not runtime collaborators.

## Architectural principles

### Ports and adapters

Domain and application code do not import Pi, filesystem, Git, npm, process, or
terminal APIs. They depend on typed ports implemented by infrastructure
adapters.

### Normalized contracts

Foreign marketplace and manifest formats terminate at reader boundaries. All
downstream behavior uses one normalized domain model.

### Complete-bundle validation

Compatibility is determined from the complete plugin inventory before any
component activates.

### Immutable revisions

Installed plugin content is immutable. Updates create new revisions and commit
selection through authoritative state only after validation and trust succeed.
A revision becomes visible only after complete content, strict metadata, an
exclusive `READY` marker, read-only sealing, and the required durability
barriers. A platform without atomic no-replace directory publication, file and
directory sync, or reliable POSIX-style mode enforcement fails the immutable
store capability probe rather than claiming a weaker guarantee.

### Derived runtime projections

Skills, hooks, and MCP activation are derived from authoritative plugin-host
state. Generated runtime configuration is replaceable and is never an
independent source of truth.

### Fail closed

Malformed paths, conflicting manifests, unsupported executable behavior, and
ambiguous identity prevent activation.

## Package shape

Source is TypeScript 7.0. The private `@nklisch/pi-plugins@0.0.0` candidate
builds ESM JavaScript for Node.js 24 and publishes compiled entry points rather
than relying on Pi's runtime TypeScript loader. Its Pi resource list loads a
candidate-owned receipt wrapper for the bundled subagent extension before the
host extension, so one top-level Pi installation composes both runtimes. Zod 4
schemas are the runtime contract source of truth; public TypeScript types are
inferred from those schemas rather than maintained as parallel interfaces.

```text
src/
├── domain/
│   ├── identity.ts
│   ├── source.ts
│   ├── provenance-location.ts
│   ├── provenance.ts
│   ├── schema.ts
│   ├── configuration.ts
│   ├── components.ts
│   ├── marketplace.ts
│   ├── plugin.ts
│   ├── compatibility.ts
│   ├── error-contract.ts
│   ├── domain-error.ts
│   └── errors.ts
├── application/
│   ├── ports.ts
│   ├── marketplace-service.ts
│   ├── inspection-service.ts
│   ├── installation-service.ts
│   ├── activation-service.ts
│   ├── update-service.ts
│   ├── adoption-service.ts
│   └── recovery-service.ts
├── formats/
│   ├── claude/
│   │   ├── marketplace-reader.ts
│   │   ├── manifest-reader.ts
│   │   └── hook-reader.ts
│   ├── codex/
│   │   ├── marketplace-reader.ts
│   │   ├── manifest-reader.ts
│   │   ├── hook-reader.ts
│   │   └── state-reader.ts
│   ├── agent-skills/
│   │   └── skill-reader.ts
│   ├── marketplace-reader-support.ts
│   └── marketplace-merger.ts
├── infrastructure/
│   ├── filesystem/
│   ├── git/
│   ├── npm/
│   ├── state/
│   ├── trust/
│   ├── secrets/
│   ├── processes/
│   └── adoption/
├── runtime/
│   ├── skills/
│   ├── hooks/
│   ├── mcp/
│   └── subagents/
├── pi/
│   ├── extension.ts
│   ├── commands.ts
│   ├── plugin-manager-ui.ts
│   ├── trust-ui.ts
│   └── reload.ts
└── index.ts
```

Tests mirror these boundaries under `test/`, with external-format fixtures under
`test/fixtures/`.

## Domain model

### Identity

```typescript
type MarketplaceId = string;
type PluginName = string;
type PluginKey = `${PluginName}@${MarketplaceId}`;

interface PluginIdentity {
  key: PluginKey;
  marketplaceName: string;
  marketplaceEntryName: string;
  manifestName?: string;
}
```

The marketplace entry name is authoritative for installation lookup.
The manifest name remains available for component namespacing and diagnostics.

### Source

```typescript
type MarketplaceSource =
  | { kind: "github"; repository: string; ref?: string }
  | { kind: "git"; url: string; ref?: string }
  | { kind: "local-git"; path: string; ref?: string };

type PluginSource =
  | { kind: "marketplace-path"; path: string }
  | { kind: "git"; url: string; ref?: string; sha?: string }
  | { kind: "git-subdir"; url: string; path: string; ref?: string; sha?: string }
  | { kind: "npm"; package: string; selector?: string; registry?: string };
```

A canonical source representation provides stable equality, hashing, cache
identity, and trust identity. Domain source schemas are strict: Git accepts
HTTPS, `ssh://`, and common SCP-style `user@host:path` forms. SCP is
remote-home-relative and remains distinct from absolute `ssh://` paths: its
canonical value uses a tagged `scp://` form with lowercase hosts and literal
percent/path text, while explicit SSH port 22 is normalized away. npm registries
are HTTPS-only. Embedded HTTPS credentials, unsupported URL protocols, malformed
percent escapes in URI forms, unknown fields, lone UTF-16 surrogates, and
non-full Git SHA pins fail at the boundary. Canonical bytes use the injective
`source-v1|<kind>|<field>:<UTF-8-byte-length>:<value>` grammar; malformed
percent escapes are rejected rather than treated as literal text.

### Normalized marketplace

Catalog entries are unresolved declarations, not partial plugin bundles:

```typescript
interface NormalizedMarketplace {
  name: Claimed<MarketplaceName>;
  entries: NormalizedMarketplaceEntry[];
  metadata: RetainedMetadata[];
  sourceDocuments: Provenance[];
}

interface NormalizedMarketplaceEntry {
  identity: Claimed<PluginIdentity>;
  source: Claimed<PluginSource>;
  version?: Claimed<string>;
  description?: Claimed<string>;
  policy?: MarketplaceInstallationPolicy;
  authorities: MarketplaceAuthority[];
  declarations: MarketplaceEntryDeclaration[];
  metadata: RetainedMetadata[];
  rawDeclaration: Claimed<JsonValue>;
}
```

The catalog-declared root name is authoritative. Claude authority metadata
preserves explicit or default `strict`: strict entries require manifests and
treat catalog runtime fields as supplemental, while `strict: false` permits a
catalog-authoritative entry. Codex requires its plugin manifest and treats
catalog runtime declarations as supplemental. Bundle ingestion resolves those
authority records after materialization. Runtime-bearing and dependency
declarations remain raw, source-located data until compatibility policy assigns
meaning. Known nested declarations are structurally validated per field before
retention; malformed nested values omit only their complete entry. Presentation
fields such as category, tags, and host-specific interface values remain
host-qualified `RetainedMetadata` with their raw JSON Pointer claims.

### Normalized bundle

```typescript
interface Claimed<T> {
  value: T;
  provenance: readonly [Provenance, ...Provenance[]];
}

interface NormalizedPlugin {
  identity: PluginIdentity;
  version?: Claimed<string>;
  description?: Claimed<string>;
  source: ResolvedPluginSource;
  configuration: PluginConfiguration;
  components: PluginComponents;
  metadata: RetainedMetadata[];
}

interface PluginComponents {
  skills: SkillComponent[];
  hooks: HookComponent[];
  mcpServers: McpServerComponent[];
  foreign: ForeignComponent[];
}

interface ForeignComponent {
  kind: "foreign";
  id: ComponentId;
  nativeHost: "claude" | "codex";
  nativeKind: Claimed<string>;
  declaration: Claimed<JsonValue>;
}
```

Every normalized value carries its own source provenance. Equivalent declarations
may contribute multiple provenance records; conflicting values therefore identify
the exact declarations without relying on a separate flat claims list. Readers
retain unknown runtime declarations as foreign components. Compatibility policy,
not the format reader, assigns their verdict.

### Compatibility

```typescript
type ComponentVerdict =
  | { kind: "supported" }
  | { kind: "metadata-only"; reason: string }
  | { kind: "incompatible"; reason: string };

interface ComponentAssessment {
  componentId: ComponentId;
  verdict: ComponentVerdict;
  requirementIds: RuntimeRequirementId[];
  diagnostics: Diagnostic[];
}

interface RuntimeRequirementAssessment {
  requirement: RuntimeRequirement;
  status: "available" | "unavailable";
  explanation: string;
}

interface CompatibilityReport {
  plugin: PluginIdentity;
  activatable: boolean;
  components: ComponentAssessment[];
  requirements: RuntimeRequirementAssessment[];
  diagnostics: Diagnostic[];
}
```

`activatable` is derived: it is true only when no runtime component is
incompatible and every requirement cited by a supported component is available.
Conditional support is represented by a supported verdict plus an explicit
runtime requirement, not by a fourth verdict. This domain defines report
mechanics; compatibility rule instances live in the compatibility evaluator.

## Format ingestion

### Reader isolation

Each format reader:

1. Parses unknown input with a runtime schema.
2. Resolves only syntax and semantics belonging to that format.
3. Emits normalized claims with provenance.
4. Does not access state or activate resources.

Format modules import only domain and sibling format modules, never Node,
filesystem, application, runtime, or Pi APIs. Marketplace readers validate path
syntax only; materialized containment is a later boundary. Every claim uses an
RFC 6901 JSON Pointer (the empty pointer denotes the document root) and preserves
its raw declaration. Repository subdirectories normalize `plugin` and
`./plugin` to one domain path while retaining the foreign spelling in
provenance. A malformed nested runtime-bearing field invalidates the complete
entry rather than producing a partial entry.

Raw JSON errors and untrustworthy catalog roots throw `BoundaryError`; malformed
entries return diagnostics beside valid siblings. The dedicated marketplace
merger orders provenance Claude then Codex, compares sources through canonical
source serialization (selectors included), treats root identity disagreement as
fatal, and isolates entry conflicts. It is separate from manifest merging
because the two boundaries have different authority and fatality rules. The
merger also verifies that each caller-supplied native-host label agrees with
all source documents, diagnostics, authorities, entries, and claim provenance
before reconciliation.

The reader reports unknown runtime fields rather than discarding them.

### Dual manifests

When both manifests exist, the merger compares their normalized claims.

Equivalent declarations collapse into one component. Complementary
metadata combines. Conflicting identity, path, hook, or MCP declarations
produce a compatibility error containing both source locations.

No host receives unconditional precedence.

### Conventional discovery

Manifest readers emit explicit component roots. A separate conventional
discovery pass adds format-defined default paths only when the relevant
manifest rules allow them.

This keeps path convention separate from JSON parsing and makes it testable
against each host's documented behavior.

## Source acquisition

Source materialization is a staging producer, not a store or transaction manager. The lifecycle caller allocates a new empty private staging slot. A materializer writes only `content/` and temporary `.work/` children inside that slot, removes temporary work before success, and returns the content root, verified resolved source, and deterministic content manifest. Error or cancellation returns no partial handoff and cleans materializer-owned writes. Lifecycle code separately owns cache and marketplace paths, atomic promotion, state, locks, fsync/journaling, rollback, recovery, retention, and garbage collection.

The source tree and archive are treated as malicious. The security boundary assumes lifecycle created a private staging slot and that an already-materialized marketplace root is immutable for the duration of a marketplace-relative copy. It does not claim portable resistance to a privileged local process that can concurrently mutate those private roots.

### Marketplace store

Marketplace registration and cached catalog content are host-global. The user
state document owns that registry as a durable host storage boundary; projects
do not own separate marketplace registrations. Catalog projection combines one
global marketplace snapshot with the requested user or project plugin target,
so plugin installation and lifecycle remain independently scoped.

A marketplace is materialized by a content-addressed identity derived from its
verified canonical source hash, immutable Git revision, and source/content
binding. Its physical key is a validated `marketplace-store-v1` digest under
`stores/marketplaces/v1/`. Authoritative marketplace snapshot state selects the
revision used for catalog browsing; there is no filesystem `current` symlink or
mutable store pointer. Refreshing a marketplace creates another immutable
snapshot.

### Plugin store

Plugin content is stored by a validated `plugin-store-v1` key derived from its
verified canonical source hash and source/content binding under
`stores/plugins/v1/`. Marketplace-relative plugins are copied from the verified
marketplace snapshot. External Git and npm plugins are materialized
independently. Store keys never contain source URLs, display aliases, plugin
names, project paths, or absolute filesystem paths.

### Secure copying

Every acquisition adapter writes through one hardened content sink into an initially empty root. The sink:

- rejects traversal, absolute/drive/UNC/backslash paths, dangerous platform names, case or Unicode-normalization collisions, and escaping links before creating the affected entry;
- uses exclusive regular-file creation, validates every ancestor, creates safe internal symlinks only after ordinary entries, and materializes hardlinks as regular-file copies;
- enforces entry, path, file, total decompressed-stream, compressed-byte, and expansion-ratio limits; tar framing, padding, and PAX/GNU metadata count toward the decompressed budget;
- rejects special files, sparse/unknown archive forms, setuid/setgid metadata, escaping symlinks/hardlinks, and `.git` content;
- performs a disk-backed final rewalk and rehash before returning, and exposes the same verification operation for lifecycle handoff; a returned root must be exactly `<slot>/content`;
- emits a versioned SHA-256 manifest over normalized relative paths, content/link digests, normalized executable modes, and empty directories; public verification applies bounded per-path, aggregate-path, and entry limits with one normalized path map.

Git resolution uses argument-array subprocesses and clean `git archive` output. Before a remote process starts, one egress policy normalizes the exact HTTPS/SSH authority, rejects loopback, link-local, private, mapped-private, and special IPv4/IPv6 destinations by default, and DNS-pins an approved address for every Git network command. Private enterprise destinations require an exact configured origin. HTTPS redirects remain disabled. Ambient proxies are always disabled because they bypass destination pinning. Credential helpers, extra headers, and SSH agents/config/identities are removed unless their source authority is separately approved exactly; SSH still pins the resolved host and disables proxy/agent forwarding escapes. A full declared SHA is authoritative over a ref. Otherwise qualified branch/tag names resolve exactly; an unqualified name that exists as both branch and tag is rejected as ambiguous. Tags peel to commits, and the resolved full commit SHA is trust identity. Selected trees containing `.gitmodules` are rejected because submodule materialization is not supported.

npm acquisition reads packuments and downloads tarballs directly through DNS-pinned bounded HTTPS adapters. It requires canonical SHA-512 integrity, hashes bytes confirmed written and rehashes the closed scratch file before extraction, and never runs npm installation, dependency installation, or lifecycle scripts. Git archives are consumed through a live bounded stream with incremental file hashing. Git and npm scratch is created only below the caller's `<slot>/.work`; no OS temporary directory is selected by a materializer. A source handoff binds the verified source hash to the manifest root digest.

### Source ports

```typescript
interface MarketplaceMaterializer {
  materialize(
    source: MarketplaceSource,
    destination: StagingSlot,
    signal: AbortSignal,
  ): Promise<MaterializedMarketplace>;
}

interface PluginMaterializer {
  materialize(
    source: PluginSource,
    context: SourceContext,
    destination: StagingSlot,
    signal: AbortSignal,
  ): Promise<MaterializedPlugin>;
}

type SourceContext =
  | { kind: "external" }
  | {
      kind: "marketplace";
      root: string;
      source: ResolvedMarketplaceSource;
      contentRootDigest: ContentDigest;
      content: ContentManifest;
      binding: ContentDigest;
    };

interface MaterializedPlugin {
  root: string;
  source: ResolvedPluginSource;
  content: ContentManifest;
  binding: ContentDigest;
}
```

Marketplace-relative sources require a verified marketplace handoff carrying the complete manifest and source/content binding; the copier rewalks the exact `<slot>/content` root before copying. External Git/npm sources reject marketplace context. The lifecycle can call `verifyMaterializedContent` to rewalk and rehash a completed handoff before promotion. Git subprocess and npm/HTTP/filesystem details remain inside infrastructure adapters. The Node composition root wires those adapters behind the application ports and exports only the lifecycle-facing materializers; command, tar, HTTP, filesystem, and credential adapters are not package API. Credentials come only from existing noninteractive Git/SSH/npm configuration whose exact origin has separate credential authority; they never come from source declarations or materializer results. Cross-authority HTTP redirects require exact target approval, while ambient proxies remain disabled. Cancellation propagates through every port and is rethrown after cleanup rather than converted to a domain diagnostic. Cleanup failure is reported as an adapter failure with no materialization handoff.

## Authoritative state

The current state boundary is schema-first and adapter-neutral. Six
independently versioned families define host configuration, installed user
state, trust evidence, project-local state, portable project intent, and
generation pointers. A single `StateDocumentRegistry` owns their current
schemas, migrations, routing, and isolation policy.

`.pi/plugins.json` is declarative and portable. It identifies desired
marketplaces and plugins but does not claim that they are materialized or
trusted on every machine. Machine-local project context uses a `ProjectKey`
derived from a canonical root and repository fingerprint when available; a
path-only identity is explicit and does not masquerade as repository identity.

A user pointer selects exactly the host-config, installed-user, and trust
families for one generation. A project pointer selects only project-local
state. Pointer and document references are logical versioned hashes, never
physical paths. Valid records may be quarantined independently after a trusted
envelope; invalid pointers, scope bindings, generations, digests, and unknown
future versions fail the enclosing snapshot without exposing a partial value.

The public store port is intentionally small:

```typescript
interface LifecycleStateStore {
  read(scope: ScopeContext, signal: AbortSignal): Promise<StateLoadResult>;
  commit(mutation: StateMutation, signal: AbortSignal): Promise<StateCommitResult>;
}
```

Reads and writes are schema-validated. Structural mutation schemas are
unverified input contracts; `parseStateMutation(input, sha256)` is the only
verifier factory and returns an opaque mutation accepted by the store port. It
recomputes canonical evidence, logical references, scope, and generation
bindings before branding that value. Mutations replace one or more documents
against an expected generation and return a typed stale-generation result
rather than overwriting newer state. The port does not prescribe storage,
paths, locks, transaction callbacks, fsync/rename, secret storage, trust
policy, promotion, generated projections, operations, or recovery. Lifecycle
features provide these schema and application contracts; the packaged
`epic-native-plugin-management` composition owns concrete authoritative-state,
credential, configuration-path/write-id, inventory, recovery-artifact, and
project-root adapters. No current state schema contains secret values, expanded
environment, absolute installed/data paths, projection contents, timestamps in
portable intent, or native error causes.

## Installation transaction

```text
resolve
  → materialize staging
  → parse
  → normalize
  → validate compatibility
  → inspect trust
  → prepare runtime projections
  → acquire scope-qualified plugin keys
  → acquire the SQLite scope lock
  → read and verify expected generation
  → run the prepared promotion callback
  → commit the verified mutation
  → write pending transition
  → reload
  → verify activation
  → finalize transition
```

Long-running network, source materialization, inspection, compatibility, trust,
and projection preparation happen before coordination. `createKeyedMutationScheduler`
and `createGenerationMutationCoordinator` then compose scope-qualified FIFO
ownership with the application `ScopeLockManager`; scheduler callbacks expose no
nested-acquisition capability. The SQLite adapter holds its rollback-journal
`BEGIN IMMEDIATE` transaction only for the short guarded window. Initialization
binds a durable root marker and per-database path identity marker; missing,
mismatched, or replaced initialized paths fail closed. Its private root is
capability-probed for a platform/filesystem pair covered by the adapter, and
unknown or network filesystems fail closed. SQLite busy code 5 is retried with
caller cancellation and bounded application jitter. Locks do not expire, claim
fairness, or fall back to process-local safety; process death releases the OS
lock, while a paused live owner remains held. `LifecycleStateStore.commit`
remains the final compare-and-swap authority. A commit error or cancellation is
reconciled by reading authority under the still-held scope lock: only an exact
expected-generation-plus-one snapshot becomes committed evidence; unchanged
state is explicit failure and any other/unreadable state is explicit ambiguity.
An uncertain cleanup after a committed result is reported with committed evidence
rather than replayed blindly.

A pending transition records:

- candidate revision;
- previous active revision;
- expected state generation;
- prepared projection hashes;
- operation identifier;
- recovery status.

On successful reload, the new extension instance verifies the projections and
marks the transition active. On failed or interrupted activation, recovery
restores the previous revision.

## Revision retention and recovery

Updating does not immediately delete the prior revision. Existing Pi sessions
may still execute hooks or MCP processes from its path.

Inactive revisions enter a grace period before garbage collection. Persistent
plugin data remains outside revision directories and survives updates.

At startup, recovery:

1. removes abandoned staging directories;
2. inspects pending transitions;
3. finalizes verified activations;
4. restores previous revisions for failed activations;
5. reports state corruption without disabling unrelated plugins;
6. removes expired inactive revisions only when no active state references them.

## Runtime activation

### Skills adapter

The extension handles `resources_discover` and returns skill paths for every
enabled, trusted plugin in the current user and project scope.

Skill state is not copied into Pi settings. Reloading recomputes the complete
path set from plugin-host state.

### Hook adapter

The hook adapter owns foreign command-hook execution. It does not copy hooks
into Pi settings.

```text
Pi event
  → normalized hook event
  → matcher evaluation
  → compatible stdin payload
  → command execution
  → output validation
  → Pi event decision/result
```

The adapter provides:

- event-specific input builders;
- case-aware tool-name aliases;
- plugin root and data environment variables;
- cancellation and timeout propagation;
- concurrent handler execution where required;
- deterministic decision aggregation;
- explicit rejection of unsupported outputs;
- recursion guards for Stop continuation.

Hook definitions are parsed and validated during installation. Runtime execution
does not reinterpret raw manifest JSON.

### Subagent adapter

The subagent adapter integrates with the pinned published
`@nklisch/pi-subagents@18.0.4-nklisch.0` lifecycle contract; Plugin Host does
not implement its own subagent runtime. Faithful `SubagentStart` and
`SubagentStop` hooks run before the exact child prompt and before final
completion, so hooks can inject context, deny a turn, replace a result, or
request bounded same-session continuation. Observational completion events
alone are insufficient.

The concrete wrapper is the only package boundary. Before evaluating package
code, it verifies the exact registry provenance receipt and a canonical digest
of the bundled package-owned tree, then resolves the documented root service
export, validates every lifecycle handoff, and maps unexpected package failures
to redacted boundary errors. Its receipt also pins the release tag and commit,
upstream base, MIT license, manifest exports and Pi resource, Node/Pi ranges,
and unchanged conformance vectors. A missing, malformed, drifted, or
runtime-incompatible service leaves only `pi.subagents.lifecycle-interception`
unavailable; a plugin declaring subagent hooks is then incompatible while
ordinary plugins continue.

### MCP adapter

MCP activation uses a package-neutral `McpRuntimePort`. A complete plugin-scoped
source is wrapped in a canonical registration digest and published only through
an exact absent/current compare-and-replace precondition. Runtime inspection
returns the exact source identity, registration digest, and redacted local
server inventory. Replace and remove success includes cleanup of source-owned
tools, caches, providers, processes or connections, and runtime revision leases.

A stateless lifecycle participant consumes exact previous and desired MCP states
from the whole-plugin transition authority. It performs at most one source
mutation, independently inspects the result, and contributes strict MCP evidence
to the existing activation observation. It does not commit state, settle a
transition, maintain a journal, or choose recovery policy. The existing
lifecycle reconciler and startup recovery service remain authoritative.

Launch values are resolved only at process or connection creation and disposed
immediately. Remote credentials require HTTPS; plaintext HTTP is restricted to
an unauthenticated literal loopback endpoint whose scheme, host, effective port,
and path are bound into exact install consent. Endpoint authority and path are
not late-bound. A separate runtime lease provider pins the existing immutable
plugin and projection artifacts until that execution closes. Registration and
observation are local and offline-safe; remote connection, authentication,
tool-discovery, and launch failures remain redacted per-server health rather
than activation identity.

Production composition uses the exact published
`@nklisch/pi-mcp-adapter@2.11.0-nklisch.0` package through its documented
`@nklisch/pi-mcp-adapter/programmatic` export, with initial plugin sources
registered before MCP tools and foreign file discovery disabled. Before package
code executes, the wrapper verifies registry SRI
`sha512-kkMQwrNbggAhSCJCJUxVLKKiMswKjYaEbOLNSZrZlYY2teoxrtKld2+3MQpvsHDJYFypi1PPHuAS2YC/0z+7tg==`,
installed-tree digest
`sha256:4f427e1aae57a5b7738a07df7311f4a758e13c61b8b1d50924fd70599e3b3bf5`,
release tag object `39c0c367db35ecb125b05ad0b9b639bc6b09b97d`, release commit
`1c1cd71fd069bc65cc06bf49399d83ff9e3d008b`, upstream base
`82724dccc13a49310530898f922bafff12b7f3fe`, MIT license digest
`2d20dfacd9742706e564470dc77438608a1e54b0ed46959f080709389209093c`, manifest
exports (`.` and `./programmatic`) and Pi resource (`./index.ts`), Node
`>=22.19.0`, and Pi peer range `>=0.79.1 <1`.
Package-specific ordering, source isolation, replace/remove cleanup,
cancellation, redaction, late-value disposal, unchanged standalone behavior,
and portable plus real-Pi conformance must also remain exact. Any version,
tree, manifest, API, license, range, or conformance drift leaves MCP unavailable
before the drifted package is imported or executed; dependent plugins fail
closed while unrelated plugins continue. The standalone package extension and
file/cache discovery remain outside host composition.

MCP server names derive from plugin identity and the native server key.
Compatibility aliases preserve foreign tool references where the MCP runtime
can expose them without collision.

## Runtime projections

Activation produces immutable projections:

```typescript
interface PluginRuntimeProjection {
  plugin: PluginKey;
  revision: string;
  skillRoots: string[];
  hooks: NormalizedHook[];
  mcpServers: NormalizedMcpServer[];
  hash: string;
}
```

Projection roots under `generated/v1/` are scope/plugin/digest-bound caches
outside immutable content and persistent data. They are prepared privately,
sealed read-only, durably synchronized, and published behind an exclusive
`READY` marker. They can be replaced and rebuilt from authoritative installed
state; no projection path or active projection pointer is persisted in state.

A projection hash participates in pending-transition verification and trust
comparison. Persistent plugin data uses a stable scope/plugin reference under
`data/v1/`, so updates resolve a new immutable content root while retaining the
same writable data root.

## Trust

### Trust subject

Trust binds to:

- canonical marketplace source;
- canonical plugin source;
- immutable revision;
- normalized skill inventory;
- normalized hook definitions;
- normalized MCP process and remote endpoint definitions.

### Trust flow

The presentation adapter shows the compatibility report, executable surface,
and required plugin configuration before initial activation. It collects
non-sensitive values and passes sensitive values directly to the `SecretStore`.
The application layer receives a `TrustGrant`; it never prompts directly.

Automatic updates are configurable per marketplace and disabled by default for
third-party sources. Enabling automatic updates authorizes Pi to acquire,
validate, and activate compatible revisions from the same trusted marketplace
and plugin source, including revisions that change hook or MCP execution
definitions.

Automatic-update trust does not cross a source-identity change. A changed
repository, registry, package identity, marketplace ownership, or plugin source
requires explicit approval.

Compatibility, validation, and activation failures preserve the active revision
regardless of update policy.

## Update discovery and notifications

Pi performs rate-limited, non-blocking update-availability checks for every
configured remote marketplace. This behavior is independent of automatic-update
settings.

When an installed plugin has a newer revision, Pi notifies the user once for
that revision. The notification identifies the plugin, installed version,
available version or source revision, and whether Pi applied the update
automatically or requires `/plugin update`.

Update checks run outside the startup-critical path. Offline operation and
network failure preserve the active revision and do not block Pi startup.

## Pi integration

### Extension lifecycle

The extension factory registers:

- `/plugin`;
- lifecycle event handlers;
- the hook adapter;
- the MCP integration;
- resource discovery;
- recovery and status reporting.

`session_start` loads local state and performs recovery without blocking on
network access. It also schedules update-availability checks after the local
runtime is ready.

`resources_discover` contributes active skill roots.

Lifecycle commands execute application services and invoke `ctx.reload()` only
after a committed change requires resource replacement.

### Presentation

The Pi adapter contains no installation rules. It renders domain results and
sends typed commands to application services.

`/plugin` presents five user-centered sections: My Plugins, Discover, Sources,
Updates, and Health. Empty states provide Add Source and Discover onboarding,
and lifecycle actions are derived from current facade detail rather than shown
unconditionally. Trust and destructive confirmation use a framed replacement
surface, not Pi's experimental floating-overlay path. Command subcommands call
the same application services as the interactive manager.

Default help and completion expose the concise add/remove/update/enable/disable/
list/doctor vocabulary plus source management. Protocol-phase routes remain
parseable for automation without being advertised as ordinary user tasks.

Non-interactive modes return explicit text or structured errors instead of
attempting terminal-only UI.

## Error model

The domain exposes one common typed contract:

- `DomainContractError` carries the stable code, operation, optional identity and
  location, JSON-safe details, and a native `cause` for logs;
- `BoundaryError` narrows the code set for an unusable marketplace/manifest root,
  source resolution failure, containment failure, or adapter failure;
- `ClaimConflictError` extends `DomainContractError`, retains both typed claims,
  and includes safe snapshots of both claims in its diagnostic details.

Application and runtime adapters may add boundary-specific errors such as
`ActivationError`, `McpRuntimeError`, or `HookExecutionError`, but domain code
never imports those adapters. Every serialized diagnostic contains an operation,
stable code, severity, and actionable message; causes are intentionally omitted
from the JSON projection. A successful `ReadResult` carries warning diagnostics
only, while a failed result carries at least one error diagnostic.

Readers return stable-code diagnostics for malformed entries and may preserve
valid siblings in a partial-success collection result. They throw typed boundary
errors only when the enclosing marketplace or manifest root cannot be trusted,
or when an external adapter fails. One malformed plugin entry therefore does not
invalidate an otherwise valid marketplace. A malformed marketplace root prevents
registration because its identity cannot be trusted.

## Concurrency

- `KeyedMutationScheduler` serializes scope-qualified plugin mutations in FIFO order; canonical multi-key acquisition prevents order cycles and its callback cannot recursively acquire another scheduler key.
- `ScopeLockManager` protects one complete user or project scope across processes; durable root/database markers and live path-identity checks reject replacement.
- `createGenerationMutationCoordinator` checks generation before its callback, runtime-validates exact scope and expected-plus-one commit responses, and lets `LifecycleStateStore.commit` perform the final compare-and-swap.
- Different plugin sources may download concurrently, and long-running preparation never runs under the scope lock.
- SQLite uses one rollback-journal database per scope, a zero native busy timeout, and cancellable application-level retries; local capability failure is fatal.
- State commits remain short and serialized; cleanup failure after commit carries committed evidence.
- Hook handler concurrency follows the normalized foreign event contract.
- MCP process lifecycle belongs to the MCP runtime.
- Abort signals propagate through Git, npm, hook, MCP, scheduler waits, and lock acquisition.

## Testing strategy

### Unit tests

- schemas and format readers;
- dual-manifest reconciliation;
- path containment and symlink behavior;
- compatibility verdict derivation;
- identity and source canonicalization, including malformed-percent and encoded-delimiter vectors;
- strict source protocols, credential rejection, immutable revision/integrity shapes, and resolved-source hash binding;
- hook matcher and output mapping;
- state migration and transaction logic.

### Contract fixtures

Fixtures represent:

- Claude-native marketplaces and plugins;
- Codex-native marketplaces and plugins;
- dual-format plugins;
- every supported source form;
- supported command hooks;
- unsupported hook types and events;
- standard-I/O and HTTP MCP servers;
- unsupported runtime components;
- conflicting manifests.

### Integration tests

Integration tests use temporary Git repositories, npm archives, agent homes, and
project roots. They verify complete lifecycle operations and crash recovery.
The committed tooling tests also prove dependency-cruiser rejects domain imports
from Node built-ins and outer layers, and that the built ESM package exposes only
its explicit runtime export allowlist.

### Pi adapter tests

A fake Pi API verifies command registration, event mapping, resource discovery,
reload behavior, project trust, and non-interactive degradation.

### End-to-end tests

Final acceptance starts with an empty consumer `node_modules` tree, installs the
packed `@nklisch/pi-plugins` candidate from the replayed lock/SRI registry
snapshot, and verifies exact receipts for
`@nklisch/pi-mcp-adapter@2.11.0-nklisch.0` and
`@nklisch/pi-subagents@18.0.4-nklisch.0`. In a clean Pi environment with no
Claude or Codex state, one revision-bound production fixture carries a skill,
ordinary hooks, subagent interception, and canonical MCP through install,
disable, enable, V1-to-V2 update, restart, and uninstall. Real Pi processes
observe every runtime surface, the honest `RUNTIME_ALIAS_UNAVAILABLE` omission,
package-drift rejection before execution, interrupted-transition recovery,
multiprocess contention, presentation and secret non-retention, offline restart
without eager MCP launch, explicit post-restart MCP use, SQLite integrity, and
complete post-uninstall runtime and inventory absence.

## Alternatives rejected

### Calling Claude or Codex

This makes foreign installations runtime dependencies and violates standalone
operation.

### Requiring Pi manifests in plugins

This preserves the packaging burden the project removes.

### Loading foreign caches directly

Foreign hosts own and garbage-collect those paths. Their undocumented state
cannot be an availability dependency.

### Writing skills and hooks into Pi settings

This creates competing writers and makes generated activation state appear
authoritative. Runtime adapters derive both surfaces directly from plugin-host
state instead.

### Reimplementing MCP

Transport, authentication, discovery, elicitation, and process management
already belong to a dedicated MCP implementation. Plugin Host integrates
through a port.

### Partial installation

A plugin is a behavioral bundle. Omitting declared runtime components changes
its contract and produces false compatibility.
