# Pi Plugin Host Specification

## Product boundary

Pi Plugin Host independently installs and runs compatible plugins published for
Claude Code or OpenAI Codex. Neither foreign host nor its CLI is required.

A plugin is compatible when every declared runtime component maps faithfully to
one of these supported surfaces:

1. Agent Skills
2. Command lifecycle hooks
3. MCP servers

Installation, enablement, updates, and removal operate on the complete plugin.
Individual components are not independently managed.

## Runtime and distribution

- Language: TypeScript 7.0
- Module system: ESM
- Runtime: Node.js 24 or newer
- Host: Pi coding agent
- Distribution: private `@nklisch/pi-plugins` Pi package (candidate version
  `0.0.0`) containing the plugin-host extension and its runtime dependencies;
  one top-level Pi installation loads the receipt-gated bundled subagent
  extension before the host extension
- Validation: runtime schemas at every external configuration boundary
- Tests: Vitest with isolated filesystem, Git, process, and Pi-host adapters

The package does not require Claude Code or OpenAI Codex to be installed. Its
published MCP and subagent adapters are admitted only when the exact registry
SRI receipt, canonical installed package-owned tree digest, manifest exports and
Pi resources, license, Node/Pi ranges, documented API, and behavioral
qualification remain exact. Drift leaves only the affected capability
unavailable before dependent plugin activation.

## Marketplace sources

Marketplace registration is host-global. It is shared by user- and
project-scoped plugin installations; only plugins carry an installation scope.
The host-global registry is persisted in the user state document, but that is a
storage boundary rather than marketplace scope.

A marketplace can be registered from:

- GitHub shorthand such as `owner/repository` (the default source kind)
- HTTPS Git URLs
- SSH Git URLs
- a local Git checkout
- an optional branch, tag, or commit selector

Git declarations accept HTTPS URLs, `ssh://` URLs, and common SCP-style
`user@host:path` syntax. SCP remains remote-home-relative while `ssh://` paths
remain absolute; their canonical identities use distinct tagged forms, and SCP
host names are lowercased while its percent signs and path text remain literal.
HTTP, FTP, file, data, and other protocols are rejected. HTTPS URLs cannot
contain embedded credentials; SSH may carry its normal user component but not
an embedded password.

A Git-backed marketplace contains either:

- `.agents/plugins/marketplace.json`
- `.claude-plugin/marketplace.json`

The catalog-declared root `name` is the marketplace identity; registration
aliases never replace it. When both files exist, Pi requires those root names to
match before reading entries. Root disagreement prevents registration and
reports both source locations. Entries with the same plugin identity must
resolve consistently. Entry disagreement drops that overlapping entry with a
compatibility diagnostic while valid siblings remain available; neither host
receives implicit precedence.

Raw remote `marketplace.json` URLs are not marketplace sources. The common
registration form is therefore simply `/plugin marketplace add owner/repository`;
`--source-kind` is needed only for Git URLs and local Git checkouts.

## Marketplace entries

Supported plugin source declarations include:

- a path relative to the marketplace root;
- a local-source object whose path remains inside the marketplace root;
- a Git repository root;
- a Git repository subdirectory;
- a Git source pinned by branch, tag, commit, or declared SHA;
- an npm package with an optional version or distribution tag and HTTPS
  registry.

Declared source objects are strict contracts: unknown fields fail validation.
Git `sha` values are full 40-character lowercase hexadecimal revisions, and
resolved npm integrity values are canonical `sha512-` strings containing the
64-byte digest in standard base64. Custom npm registries must use HTTPS and
must not contain embedded credentials. Malformed percent escapes are rejected;
encoded delimiters are normalized without aliasing distinct path segments.

Catalog readers validate relative path syntax before use: paths begin with
`./`, contain no empty, `.`, `..`, backslash, NUL, or absolute segments, and
retain their declaration provenance. Repository subdirectory spellings `plugin`
and `./plugin` normalize to one declared path while the raw spelling remains in
provenance. Filesystem realpath, symlink, and materialized-root containment are
enforced only after source materialization. A relative or subdirectory source
cannot escape its containing marketplace or materialized repository.

Unknown source types fail validation with their source location and type.
Resolved source contracts retain the immutable URL/path/package fields and
revision, derive a versioned canonical source from those fields, and verify its
injected SHA-256 hash before a materializer can treat the value as trusted.

## Plugin identity

The stable external identity is:

```text
<plugin-name>@<marketplace-name>
```

The marketplace entry name controls lookup and enablement. Catalog ingestion
represents it as an unresolved `NormalizedMarketplaceEntry` with a declared
source and per-claim provenance; it does not fabricate the resolved source or
complete inventory required by `NormalizedPlugin`. A differing internal
manifest name is retained later as component-namespace metadata and reported to
the user.

Raw JSON syntax, an untrusted root shape or identity, invalid root-wide path
configuration, duplicate surviving entry names, and conflicting dual root
identities are root-fatal. Malformed entries and dual-entry conflicts are
entry-recoverable: the complete bad entry is omitted, an error diagnostic is
returned, and valid siblings survive. A malformed nested runtime or dependency
field never produces a partial entry. All claim locations use RFC 6901 JSON
Pointers; the empty pointer identifies the document root.

An installed revision records authoritative evidence only:

- marketplace and plugin identity;
- the resolved source and immutable source revision;
- declared plugin version when present;
- the canonical normalized component inventory;
- the compatibility report;
- scope-bound logical content, data, and optional configuration references.

Installed records carry activation intent and may carry only an opaque pending
transition reference. Trust evidence is independently versioned and is not trust
policy. Physical installation paths, generated projections, expanded
configuration, secret values, reload observations, and operation or recovery
payloads are not state-schema fields.

## Manifests

Pi recognizes:

- `.claude-plugin/plugin.json`
- `.codex-plugin/plugin.json`

A plugin with both manifests is a dual-format plugin. Pi validates both and
combines non-conflicting metadata. Conflicting declarations of a supported
runtime component make the plugin incompatible.

Conventional component paths are recognized when the source format defines
them. Explicit manifest paths must:

- begin with `./`;
- resolve relative to the plugin root;
- remain inside the plugin root;
- reference an allowed file or directory shape.

## Supporting plugin configuration

Claude `userConfig` is supported when its values configure a supported skill,
hook, or MCP component. Supported values include strings, numbers, booleans,
directories, files, and declared string arrays. Required values, defaults,
bounds, and path constraints are validated before activation.

Production sensitive-value custody is unavailable and fail-closed. No supported
operating-system backend can currently prove the required atomic no-replace
ownership and stale-safe deletion contract. A plugin whose activation requires
a sensitive value remains inactive with `SECRET_CUSTODY_UNAVAILABLE`.
Plaintext collected through a masked or headless input boundary is not retained
in plugin-host state, generated MCP configuration, control or terminal output,
logs, compatibility reports, projections, recovery artifacts, or process data.

Configured values are available through `${user_config.KEY}` substitution and
`CLAUDE_PLUGIN_OPTION_<KEY>` process environment variables.

## Component compatibility verdicts

Every discovered component receives one verdict:

- `supported`: Pi provides the required behavior;
- `metadata-only`: the field has no runtime effect and is safe to retain or
  ignore;
- `incompatible`: Pi cannot preserve the component's behavior.

A supported component may name explicit runtime requirements, such as a Pi
integration or platform capability. Requirement availability is assessed
separately; it is not a fourth component verdict. The plugin is activatable only
when all runtime components are supported and every requirement they cite is
available. Metadata-only fields do not prevent activation. There is no
partial-install mode.

The compatibility report lists every discovered component and its verdict
before installation changes active state.

## Domain diagnostics

The domain uses a stable error-code registry and `DomainContractError` for
serializable failures. `BoundaryError` is reserved for an untrusted enclosing
root, source-resolution failure, path-containment failure, or adapter failure.
`ClaimConflictError` is a `DomainContractError` and retains both conflicting
claims and their provenance in its diagnostic details; no declaration wins by
precedence. A successful `ReadResult` may contain warnings only. A failed
`ReadResult` must contain at least one error diagnostic. Native causes remain
available on thrown errors for logs but never appear in diagnostics.

## Skills

Supported skill forms are:

- `skills/<name>/SKILL.md`;
- manifest-declared skill directories;
- one root `SKILL.md` where the foreign format permits it;
- Claude's legacy flat command markdown when it can be represented as a Pi
  skill without changing invocation semantics.

Skills follow the Agent Skills standard. Pi retains supporting scripts,
references, and assets inside the immutable installed plugin revision.

Skill names are namespaced or disambiguated using Pi's normal collision
behavior. A collision never silently replaces a skill from another source.

Enabled plugin skill roots are contributed through Pi's
`resources_discover` lifecycle. Plugin lifecycle changes trigger Pi's normal
reload flow.

## Hooks

### Supported hook type

Only `type: "command"` hooks are supported.

HTTP, prompt, agent, MCP-tool, and unknown hook handler types are incompatible.
An asynchronous command mode that changes lifecycle ordering is also
incompatible.

### Supported events

The command-hook runtime supports events for which Pi provides a faithful
lifecycle boundary:

- `SessionStart`
- `SessionEnd`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`
- `PreCompact`
- `PostCompact`
- `SubagentStart`
- `SubagentStop`
- `Stop`

Subagent events use the installed Pi subagent service. A plugin declaring those
events is incompatible when the required service is unavailable.

Events without a faithful Pi boundary, including `PermissionRequest`, are
incompatible.

### Hook execution

Hook commands:

- run with the Pi session working directory;
- receive one compatible JSON object on standard input;
- receive the configured timeout;
- run concurrently where the foreign event contract requires concurrency;
- capture standard output, standard error, exit status, timeout, and
  cancellation;
- receive the plugin root and persistent data environment variables.

The runtime defines equivalent values for:

```text
CLAUDE_PLUGIN_ROOT
CLAUDE_PLUGIN_DATA
PLUGIN_ROOT
PLUGIN_DATA
CLAUDE_PROJECT_DIR
```

Tool matchers recognize Pi names and foreign aliases. For example, a matcher for
`Write|Edit|apply_patch` matches the corresponding Pi file-mutation tools.

Hook outputs support blocking, allowed input rewriting, additional context, and
continuation only where Pi can preserve the documented behavior. Unsupported
output fields fail compatibility validation or produce an explicit hook error;
they are not accepted as no-ops.

Exact hook mappings and limitations live in `COMPATIBILITY.md`.

## MCP servers

Plugin MCP declarations can define:

- local standard-I/O servers;
- Streamable HTTP servers;
- command arguments;
- working directory;
- environment variables;
- HTTP headers;
- bearer-token environment references;
- OAuth behavior supported by the selected Pi MCP runtime;
- startup and tool timeouts;
- enabled and disabled tool lists;
- tool approval policy where the runtime supports it.

The MCP integration preserves plugin provenance and namespaces servers by plugin
identity. Two plugins declaring the same local server key do not collide.

The host supplies expanded plugin root and data paths to the MCP runtime.
Transport management, authentication, elicitation, sampling, discovery, and
process lifecycle belong to the MCP implementation.

Pi Plugin Host integrates through a narrow plugin-scoped configuration-source
contract. The preferred implementation extends `pi-mcp-adapter`; a maintained
fork supplies the same contract when upstream does not.

A plugin is incompatible when its MCP behavior depends on a transport,
authentication mode, capability, or exact tool-name contract that the active
MCP implementation cannot preserve. Remote MCP credentials are delivered only
over HTTPS. Plain HTTP is limited to an unauthenticated literal loopback
endpoint and requires exact install consent; the consent disclosure binds and
shows its redacted scheme, host, effective port, and path. Endpoint authority
and path cannot depend on late-bound values, while approved secret query values
remain late-bound and absent from durable projections and diagnostics.

## Scopes

### User scope

User marketplace declarations, plugin state, trust, cache, and persistent data
live under:

```text
~/.pi/agent/plugin-host/
```

User-scoped plugins are available in every Pi project unless disabled.

### Project scope

Portable project declarations live in:

```text
.pi/plugins.json
```

This file contains:

- schema version;
- marketplace source declarations;
- requested plugin identities;
- source or version constraints;
- project enablement.

It does not contain absolute paths, cache locations, timestamps, credentials,
or trust decisions.

Materialized project-plugin state remains under the user's Pi agent directory,
keyed by canonical project identity. A trusted project with missing materialized
plugins requests synchronization before activation.

## State contract

The authoritative state vocabulary is six independently versioned JSON-schema
families: host marketplace configuration, installed user state, trust evidence,
project-local state, portable project intent, and generation pointers. Each
family has an explicit `schemaVersion`; a registry owns current schemas,
migrations, routing, and corruption-isolation policy.

User snapshots contain configuration, installed state, and trust evidence.
Project snapshots contain project-local state only. A pointer selects one exact
scope generation and logical blob/digest references; it does not encode a
filesystem path. Project keys bind the canonical project root and repository
identity when available, while path-only identity is explicit and limited.

The `LifecycleStateStore` port accepts validated reads and expected-generation
replacements only as opaque mutations produced by `parseStateMutation(input,
sha256)`. Structural mutation schemas are unverified input contracts and cannot
satisfy the store port; the verifier recomputes canonical evidence, logical
references, scope, and generation bindings before the mutation is accepted. The
port exposes no storage technology, path layout, lock primitive, transaction
callback, trust policy, secret store, promotion operation, projection content,
journal, or recovery payload. Those concerns remain late-bound to their owning
lifecycle features. Adapters may choose a durable representation without
changing this contract.

Portable `.pi/plugins.json` remains an all-or-nothing declaration containing
only marketplace sources, requested plugin identities, constraints, and enabled
intent. Unknown fields and machine-local or operational values fail closed.

## Lifecycle operations

The public command surface is `plugin-control/v1`. Global controls must precede
the command path:

```text
/plugin [--grammar-version plugin-control/v1] [--output human|json]
        [--timeout-ms <1..86400000>] [--non-interactive]
        [--input-stdin | --input-file <path> | --input-env-prefix <PREFIX>]
        <command>
```

Value-taking controls accept `--name value` or `--name=value`; flags do not
accept values. A global control or non-repeatable command option may appear only
once. The three JSON input channels are mutually exclusive. `--output human` is
the default concise presentation; `--output json` emits the versioned result
envelope and, when a sink is active, JSON-lines progress frames. Timeout
cancellation still emits a terminal cancelled envelope. `--non-interactive`
never opens a TUI or prompt: a command whose declared input class cannot be
satisfied by the selected channel returns explicit input-required evidence.

Default human help and slash completion present the concise product routes: `add`, `remove`, `update`, `enable`, `disable`, `list`, `doctor`, `status`, and source management under `marketplace`. Compatibility aliases remain parseable. The complete registry below also includes advanced automation and protocol-phase routes; those routes are retained for deterministic integrations but are not advertised as ordinary interactive tasks.

The table below is checked mechanically against `NativeControlCommandRegistry`.
Angle brackets are positionals or option values; brackets are optional; a
trailing `...` is repeatable.

<!-- native-control-registry:start -->
| ID | Canonical form | Safety | Input | Summary |
|---|---|---|---|---|
| `presentation` | `/plugin` | `pure` | `decision` | Open plugin management |
| `help` | `/plugin help [<path>...]` | `pure` | `none` | Show command help |
| `grammar` | `/plugin grammar [--version <value>]` | `pure` | `none` | Show grammar metadata |
| `marketplace.add` | `/plugin marketplace add <source> [--source-kind github\|git\|local-git] [--ref <value>]` | `mutation` | `none` | Add a plugin source |
| `marketplace.remove` | `/plugin marketplace remove <registration-id> --yes` | `mutation` | `confirmation` | Remove a plugin source |
| `marketplace.list` | `/plugin marketplace list [--limit <integer>]` | `local-read` | `none` | List plugin sources |
| `marketplace.refresh` | `/plugin marketplace refresh [<registration-id>...]` | `mutation` | `none` | Refresh plugin sources |
| `marketplace.adopt.preview` | `/plugin marketplace adopt preview` | `local-read` | `none` | Preview foreign marketplace adoption |
| `marketplace.adopt.import` | `/plugin marketplace adopt import <candidate-id>... --yes` | `mutation` | `confirmation` | Import selected foreign marketplaces globally |
| `browse` | `/plugin browse [<query>] [--scope user\|project\|all-current] [--marketplace-id <value>]... [--availability available\|installed-by-default\|not-available]... [--cursor <value>] [--limit <integer>]` | `local-read` | `none` | Browse marketplace candidates |
| `inspection.list` | `/plugin list [--scope user\|project\|all-current] [--query <value>] [--condition ready\|attention\|blocked\|unavailable]... [--cursor <value>] [--limit <integer>]` | `local-read` | `none` | List my plugins |
| `inspection.show` | `/plugin show <plugin-key> --scope user\|project [--snapshot-id <value>] [--detail-id <value>]` | `local-read` | `none` | Show exact plugin detail |
| `inspection.diagnose` | `/plugin doctor [<plugin-key>] [--scope user\|project] [--snapshot-id <value>] [--detail-id <value>] [--include-adoption]` | `local-read` | `none` | Check plugin host or plugin health |
| `install.open` | `/plugin install open <plugin-key> --scope user\|project [--snapshot-id <value>] [--detail-id <value>]` | `mutation` | `none` | Open a trusted installation |
| `install.apply` | `/plugin install apply <install-token>` | `mutation` | `configuration` | Apply a trusted installation |
| `install.recover` | `/plugin install recover <install-token>` | `mutation` | `configuration` | Recover a trusted installation |
| `install.run` | `/plugin add <plugin-key> --scope user\|project [--snapshot-id <value>] [--detail-id <value>]` | `mutation` | `configuration` | Add a plugin |
| `lifecycle.enable` | `/plugin enable <plugin-key> --scope user\|project [--snapshot-id <value>] [--detail-id <value>] [--preview-only] [--yes]` | `mutation` | `confirmation` | Enable a plugin |
| `lifecycle.disable` | `/plugin disable <plugin-key> --scope user\|project [--snapshot-id <value>] [--detail-id <value>] [--preview-only] [--yes]` | `mutation` | `confirmation` | Disable a plugin |
| `lifecycle.update` | `/plugin update <plugin-key> --scope user\|project [--snapshot-id <value>] [--detail-id <value>] [--preview-only] [--yes] [--candidate-snapshot-id <value>] [--candidate-detail-id <value>]` | `mutation` | `configuration` | Update a plugin |
| `lifecycle.uninstall` | `/plugin remove <plugin-key> --scope user\|project [--snapshot-id <value>] [--detail-id <value>] [--preview-only] [--yes] [--keep-data] [--delete-data]` | `mutation` | `confirmation` | Remove a plugin |
| `project.sync` | `/plugin project sync --mode apply-intent\|publish-intent\|merge [--preview-only] [--yes]` | `mutation` | `decision` | Synchronize current project intent |
| `updates.status` | `/plugin updates status [--scope user\|project\|all-current] [--plugin <value>]` | `local-read` | `none` | Show update status |
| `updates.policy.preview` | `/plugin updates policy preview --kind application\|cadence --target global\|scope\|marketplace\|plugin [--scope user\|project\|all-current] [--marketplace-id <value>] [--plugin <value>] [--mode inherit\|manual\|automatic] [--cadence paused\|conservative\|balanced\|frequent]` | `local-read` | `none` | Preview an update policy change |
| `updates.policy.apply` | `/plugin updates policy apply --kind application\|cadence --target global\|scope\|marketplace\|plugin [--scope user\|project\|all-current] [--marketplace-id <value>] [--plugin <value>] [--mode inherit\|manual\|automatic] [--cadence paused\|conservative\|balanced\|frequent] --preview-id <value> [--consent-id <value>]` | `mutation` | `decision` | Apply an exact update policy preview |
| `updates.policy.set` | `/plugin updates policy set --kind application\|cadence --target global\|scope\|marketplace\|plugin [--scope user\|project\|all-current] [--marketplace-id <value>] [--plugin <value>] [--mode inherit\|manual\|automatic] [--cadence paused\|conservative\|balanced\|frequent] [--preview-id <value>] [--consent-id <value>]` | `mutation` | `decision` | Set update policy through preview |
| `updates.notices.list` | `/plugin updates notices list [--scope user\|project\|all-current] [--plugin <value>] [--after <value>] [--limit <integer>]` | `local-read` | `none` | List update notices |
| `updates.notices.acknowledge` | `/plugin updates notices acknowledge <notice-id>...` | `mutation` | `none` | Acknowledge update notices |
| `updates.automatic.run` | `/plugin updates automatic run [--notice-id <value>]... [--limit <integer>] [--explicit]` | `mutation` | `none` | Run admitted plugin updates |
| `config.host-precedence` | `/plugin config host-precedence <order>` | `mutation` | `none` | Set dual-host declaration precedence |
| `status` | `/plugin status` | `local-read` | `none` | Show plugin host status |
| `operation.status` | `/plugin operation status <token>` | `operation-control` | `none` | Poll an existing operation |
| `operation.cancel` | `/plugin operation cancel <token>` | `operation-control` | `none` | Cancel an existing operation |
<!-- native-control-registry:end -->

The registry aliases are exact alternate paths, never fuzzy matches:

<!-- native-control-aliases:start -->
| Alias | Canonical path |
|---|---|
| `/plugin marketplace update` | `/plugin marketplace refresh` |
| `/plugin adopt preview` | `/plugin marketplace adopt preview` |
| `/plugin adopt import` | `/plugin marketplace adopt import` |
| `/plugin inspect` | `/plugin show` |
| `/plugin diagnose` | `/plugin doctor` |
| `/plugin install` | `/plugin add` |
| `/plugin install run` | `/plugin add` |
| `/plugin uninstall` | `/plugin remove` |
| `/plugin project-sync` | `/plugin project sync` |
| `/plugin updates notices ack` | `/plugin updates notices acknowledge` |
<!-- native-control-aliases:end -->

Aliases use the same request schema, confirmation policy, dispatcher, and
response schema as their canonical command. No alias performs
name-to-identifier lookup or supplies plugin mutation scope.

Cross-field grammar is strict:

- `--snapshot-id` and `--detail-id` are supplied together or omitted together;
  update candidate targeting applies the same rule to `--candidate-snapshot-id`
  and `--candidate-detail-id`. Diagnose accepts `plugin-key` only with an exact
  `--scope`, and accepts neither for host-wide diagnosis.
- Uninstall requires exactly one of `--keep-data` and `--delete-data`; the two
  options conflict. Marketplace removal and adoption import require `--yes`.
  Enable, disable, uninstall, and project sync can collect their declared
  confirmation/decision interactively when `--yes` is absent; non-interactive
  execution instead returns input-required evidence.
- Update-policy `application` changes require `--mode`; scope, marketplace, and
  plugin targets require `--scope user|project`, with `--marketplace-id` or
  `--plugin` for those exact target kinds. A `cadence` change targets `global`
  and requires `--cadence`. Policy apply requires `--preview-id`; consent is
  supplied with `--consent-id` when the preview requires it.
- Marketplace registration lists use `--limit` 1..200 (default 50). Browse and
  installed lists use opaque `--cursor` values and `--limit` 1..100 (default
  50). Notice lists page after an opaque notice ID with `--after` and use
  `--limit` 1..200 (default 50). Automatic runs accept repeatable `--notice-id`
  filters and `--limit` 1..100 (default 20).
- Repeatable inputs are help paths, marketplace-refresh registration IDs,
  adoption candidate IDs, browse marketplace/availability filters, installed
  conditions, notice acknowledgment IDs, and automatic-run notice IDs.
- `/plugin grammar --version plugin-control/v1` returns grammar version
  `plugin-control/v1`, envelope version `1`, and the registry-derived command
  metadata above. Other grammar versions fail validation.

The examples below are executed by the documentation contract test. `valid`
lines must parse; `invalid:<code>` lines must fail with that exact diagnostic.

<!-- native-control-examples:start -->
```text
valid | /plugin --grammar-version plugin-control/v1 --output json --timeout-ms 30000 --non-interactive --input-file ./request.json marketplace list --limit 50
valid | /plugin --input-stdin status
valid | /plugin --input-env-prefix PI_PLUGIN_INPUT grammar --version plugin-control/v1
valid | /plugin marketplace add owner/repository --ref main
valid | /plugin browse adapter --scope all-current --marketplace-id marketplace-registration-v1:sha256:0000000000000000000000000000000000000000000000000000000000000000 --marketplace-id marketplace-registration-v1:sha256:1111111111111111111111111111111111111111111111111111111111111111 --availability available --availability not-available --cursor marketplace-cursor-v1:next --limit 25
valid | /plugin show demo@market --scope user --snapshot-id inspection-snapshot-v1:sha256:0000000000000000000000000000000000000000000000000000000000000000 --detail-id inspection-detail-v1:item.0000000000000000000000000000000000000000000000000000000000000000
valid | /plugin updates policy preview --kind application --target marketplace --scope user --marketplace-id marketplace-registration-v1:sha256:0000000000000000000000000000000000000000000000000000000000000000 --mode automatic
valid | /plugin updates notices acknowledge update-notice-v1:sha256:0000000000000000000000000000000000000000000000000000000000000000 update-notice-v1:sha256:1111111111111111111111111111111111111111111111111111111111111111
valid | /plugin updates automatic run --notice-id update-notice-v1:sha256:0000000000000000000000000000000000000000000000000000000000000000 --limit 20
invalid:CONTROL_INPUT_CHANNEL_CONFLICT | /plugin --input-stdin --input-file ./request.json status
invalid:CONTROL_OPTION_CONFLICT | /plugin remove demo@market --scope user --yes --keep-data --delete-data
invalid:CONTROL_RETENTION_REQUIRED | /plugin remove demo@market --scope user --yes
```
<!-- native-control-examples:end -->

`/plugin` without arguments opens a Pi-native marketplace and installed-plugin
manager. The command forms remain available for deterministic operation.

An operation affecting activation invokes Pi's reload lifecycle after its state
commits successfully.

## Install transaction

Source materializers do not allocate installed, cache, or marketplace storage. The lifecycle operation supplies an empty private staging slot. The Node factory composes Git, npm, bounded HTTPS, archive, filesystem, process, crypto, and credential adapters behind the application ports; those adapter details are not public API. Materialization writes only inside that slot, keeps Git/npm scratch under `<slot>/.work`, and returns an exact `<slot>/content` root, a disk-verified resolved source, a deterministic content manifest, and a source/content binding; cancellation or failure returns no partial result and cleans materializer-owned writes. A cleanup failure is explicit and cannot become a successful handoff. Lifecycle code owns atomic promotion, state and locks, journaling/fsync, rollback, recovery, retention, and garbage collection.

Lifecycle mutation coordination uses a scope-qualified in-process FIFO scheduler plus a cross-process `ScopeLockManager`. The shipped scheduler callback has no nested-acquisition capability. The Node adapter uses one rollback-journal SQLite database per user or project scope and holds `BEGIN IMMEDIATE` only for the guarded promotion/compare-and-commit window. Initialization creates a durable root marker and per-database path-identity marker; a missing, mismatched, or replaced initialized database fails closed and is never recreated. The lock root must be private and capability-probed on a platform/filesystem pair covered by the adapter; unknown or network filesystems fail closed. SQLite busy code 5 is retried only through the caller's abort signal and bounded application jitter. There is no lock expiry, PID takeover, heartbeat, fairness guarantee, or process-local fallback: process termination releases the operating-system lock, while a paused live owner remains the owner. If a commit response is lost or cancellation arrives after a possible write, the coordinator reconciles authoritative state under the lock and returns committed evidence only for exact expected-generation-plus-one; otherwise it returns explicit failed or ambiguous evidence.

Installation and update follow one transaction:

1. Resolve the marketplace snapshot and plugin source.
2. Materialize the source into staging.
3. Determine the immutable source revision.
4. Parse all applicable manifests and conventional component locations.
5. Normalize and validate the complete component inventory.
6. Produce the compatibility report.
7. Collect required trust.
8. Prepare skills, hook, and MCP activation state.
9. Atomically promote the staged revision.
10. Atomically commit plugin-host state.
11. Reload Pi resources.
12. Confirm activation and retain or retire the prior revision.

Before state commit, failure removes staging and leaves the current installation
unchanged. Activation failure restores the prior active revision and reports the
failed candidate.

Uninstall removes activation first, then cached revisions. Persistent plugin
data is deleted only after explicit confirmation.

## Enablement

Enable and disable operations apply to the complete plugin.

Disabling a plugin removes its skills, hooks, and MCP servers from active
runtime state but preserves its installed revision, persistent data, and trust
record.

Project enablement participates in Pi's project trust boundary. Untrusted
project declarations do not activate executable components.

## Updates

An installed revision is identified by both its declared version and immutable
source revision.

Version resolution follows:

1. plugin manifest version;
2. marketplace entry version;
3. resolved Git revision;
4. resolved npm package version.

A matching declared version does not override a changed immutable source
revision in the installation record.

Explicit update checks are always available. Pi also performs rate-limited,
non-blocking update-availability checks for every configured remote marketplace
and notifies the user when an installed plugin has a newer revision. Availability
notifications do not depend on whether automatic activation is enabled and are
shown once per discovered revision.

Per-marketplace automatic updates are configurable and disabled by default for
third-party sources. Enabling automatic updates authorizes Pi to acquire,
validate, and activate compatible new revisions from the same trusted
marketplace and plugin source, including revisions that change hook or MCP
execution definitions. Source-identity changes still require explicit approval.

Network failure, validation failure, or activation failure never blocks Pi
startup or disables the active revision.

## Trust and security

Marketplace and plugin content is untrusted input.

Before activation, Pi displays:

- canonical marketplace and plugin source;
- immutable revision;
- supported component inventory;
- hook commands;
- MCP process or remote-server declarations;
- persistent-data access;
- compatibility limitations;
- changes from the active revision.

Trust is bound to source identity, immutable revision, and normalized executable
component definitions. Credentials are never stored in plugin-host state.

Project declarations require Pi project trust. Path traversal, symlink escape,
malformed schemas, ambiguous identity, and conflicting manifests fail closed. The
lifecycle-facing content verifier rewalks and incrementally rehashes the on-disk
tree against its manifest before promotion; manifest verification is bounded by
one normalized path map and aggregate entry/path limits.

Install and update operations never run npm lifecycle scripts. npm sources are resolved from bounded, DNS-pinned HTTPS packuments, require canonical SHA-512 integrity, and have their tarball bytes verified before hardened extraction; materialization never runs `npm install` or installs package dependencies. Runtime dependencies required by a plugin are installed only through an explicitly declared and trusted plugin operation.

Before any catalog-derived remote materialization, the Node acquisition boundary normalizes an exact origin and rejects loopback, link-local, private, mapped-private, and special IPv4/IPv6 destinations. DNS results are pinned into the actual Git or HTTPS connection, and redirect authority is checked before target resolution. Exact configured private enterprise origins remain supported. Credential and SSH configuration/agent use have separate exact source-origin approvals; unapproved origins receive isolated Git/SSH configuration and no ambient credential material. Ambient proxies are disabled for all acquisition because they would bypass DNS pinning.

Git sources resolve to a full commit SHA. A declared full SHA is authoritative over an accompanying ref; otherwise qualified branch/tag names resolve exactly and an unqualified name shared by a branch and tag is rejected as ambiguous. Submodule-bearing source trees are unsupported and fail closed rather than producing an incomplete bundle.

## Foreign-state adoption

Adoption reads marketplace declarations from available Claude Code and Codex
user state.

Adoption:

- is optional;
- copies selected marketplace source declarations only;
- does not reuse foreign plugin caches;
- does not import foreign trust decisions;
- does not require either foreign CLI;
- installs selected plugins through Pi's normal validation and trust pipeline.

Foreign state is never modified.

## Performance and availability

- Startup does not require network access.
- Installed plugin discovery uses local state.
- Marketplace refresh and source acquisition are cancellable.
- Long-running Git, npm, and validation operations run without blocking Pi's
  interactive loop.
- Resource reload happens only after committed lifecycle changes.
- Corrupt marketplace or plugin state is isolated and reported without
  preventing unrelated plugins from loading.

## Acceptance criteria

The system is accepted when automated tests demonstrate:

1. A clean Pi environment with no Claude or Codex installation can add a
   Git-backed marketplace.
2. Claude-native, Codex-native, and dual-manifest plugins normalize correctly.
3. A compatible plugin activates skills, command hooks, and MCP servers as one
   unit.
4. User and project scopes remain independent.
5. Project declarations contain no machine-specific paths.
6. Enable, disable, update, and uninstall affect all plugin components.
7. Failed installation and activation preserve the working revision.
8. Unsupported runtime components produce precise incompatibility reports.
9. Hook aliases, path variables, blocking, rewriting, and context injection
   behave according to the compatibility contract.
10. MCP server identity and lifecycle remain isolated between plugins.
11. Update checks do not make startup network-dependent.
12. Claude and Codex marketplace declarations can be adopted read-only.
13. From an empty consumer dependency tree, the packed product installs from a
    replayed lock/SRI registry snapshot with exact receipts for
    `@nklisch/pi-mcp-adapter@2.11.0-nklisch.0` and
    `@nklisch/pi-subagents@18.0.4-nklisch.0`.
14. One complete revision-bound production bundle proves skill discovery,
    ordinary hooks, subagent prompt injection and same-session continuation,
    canonical MCP list/call, and honest `RUNTIME_ALIAS_UNAVAILABLE` reporting
    through install, disable, enable, and V1-to-V2 update.
15. Incompatible candidates, package drift, interrupted acquisition and commit,
    multiprocess contention, cancellation, secret non-retention, and recovery
    preserve one whole working revision and keep drifted package code from
    executing.
16. V2 restarts offline without Git, a model service, network access, or eager
    MCP launch; an explicit later call remains usable.
17. Uninstall followed by restart leaves the production skill, ordinary hooks,
    subagent interception, MCP source, installed inventory, and persistent data
    absent, with no Claude or Codex installation or state.
