# Plugin Compatibility Contract

## Purpose

This document defines the foreign plugin behavior Pi Plugin Host accepts and
the Pi behavior it provides in return. It is a rolling contract: when Claude
Code, OpenAI Codex, Pi, or an integration dependency changes, this document
changes in place to describe the supported truth.

## Verdict terminology

| Verdict | Meaning |
|---|---|
| Supported | Pi preserves the relevant runtime behavior. A supported component may name runtime requirements that must be available before activation. |
| Metadata-only | The declaration is retained as evidence but never executed. This is also the degradation verdict: a component Pi cannot run faithfully is skipped, reported, and does not block the rest of the plugin. |
| Incompatible | Pi cannot preserve the declared behavior and will not install the plugin over it. Reserved for security gates (such as plaintext non-loopback HTTP with credentials); everything else degrades to metadata-only. |

Maximum compatibility with gentle degradation is the product rule: any
construct Pi does not execute is safe to install, so unsupported components
degrade instead of blocking the plugin. Degraded components stay visible in
the compatibility report before activation.

Runtime integrations and platform capabilities are represented as explicit
`RuntimeRequirement` assessments, not as a fourth component verdict. A supported
component whose required capability is unavailable prevents activation. Unknown
runtime declarations degrade to metadata-only. Unknown presentation metadata is retained
for diagnostics and treated as metadata-only.

Read results use the common domain diagnostic contract: success values carry
warning diagnostics only, and failures carry at least one error diagnostic.
`ClaimConflictError` is a `DomainContractError`; it preserves both claims and
provenance in its safe diagnostic projection. Error causes remain available to
logs but are omitted from serialized diagnostics.

## Marketplace discovery

| Surface | Claude Code | Codex | Pi Plugin Host |
|---|---|---|---|
| Native catalog | `.claude-plugin/marketplace.json` | `.agents/plugins/marketplace.json` | Supported |
| Claude-compatible catalog | Native | `.claude-plugin/marketplace.json` | Supported |
| GitHub shorthand | Supported | Supported | Supported |
| HTTPS Git | Supported | Supported | Supported |
| SSH Git (`ssh://` or common SCP `user@host:path`) | Supported | Supported | Supported; SCP retains remote-home-relative identity distinct from absolute SSH |
| Local Git checkout | Supported | Supported | Supported |
| Raw remote catalog URL | Supported | Not the shared Git path | Incompatible |
| Marketplace ref | Supported | Supported | Supported |
| Sparse marketplace checkout | Supported | Supported | Supported |

The catalog-declared root `name` is authoritative; a caller or registration
alias cannot rename the marketplace. A repository containing both catalog files
is valid when those root names and overlapping plugin entries agree. Root-name
conflicts identify both source files and prevent registration. Entry conflicts
identify both declarations and omit only that entry while valid siblings remain
browsable.

## Plugin source forms

| Source form | Status |
|---|---|
| Marketplace-relative `./path` | Supported |
| Codex local source object | Supported |
| Claude `github` source | Supported |
| Git `url` source | Supported |
| `git-subdir` source | Supported |
| `ref` selector | Supported |
| Full Git `sha` pin | Supported; exactly 40 lowercase hex characters, authoritative over `ref`, and becomes the resolved trust identity |
| Qualified Git branch/tag | Supported; resolved exactly and tags peel to commits |
| Unqualified branch/tag collision | Incompatible; rejected as ambiguous even when both currently peel to the same commit |
| Git submodules | Incompatible; `.gitmodules` fails materialization rather than producing an incomplete bundle |
| npm package | Supported through direct packument/tarball acquisition without install or lifecycle scripts |
| npm version, range, or distribution tag | Supported |
| HTTPS custom npm registry | Supported; HTTPS only and no embedded credentials |
| Embedded HTTPS Git or npm credentials | Incompatible; use configured non-interactive credentials |
| HTTP, FTP, file, or data Git URL | Incompatible |
| Malformed percent escape | Incompatible |
| Malformed or non-SHA-512 npm integrity | Incompatible |
| Unknown source fields | Incompatible |
| Source path escaping its root | Incompatible |
| Symlink escaping its source root | Incompatible |
| Unknown source type | Incompatible |

Private Git and npm sources use the user's existing non-interactive credential
configuration. Plugin Host does not store source credentials or accept
credentials embedded in HTTPS source URLs. npm supports standard `_authToken`
scopes (including registry ports) and the default `_auth` form; unreadable
configuration is an explicit adapter failure rather than anonymous fallback.
npm tarballs require canonical
SHA-512 integrity and are verified before extraction; missing or mismatched
integrity is incompatible.

Materialization writes only into a caller-provided private staging slot and
keeps all Git/npm scratch below `<slot>/.work`. It returns an exact
`<slot>/content` root, a resolved source, a deterministic content manifest, and
a source/content binding; the manifest is rewalked and rehashed from disk before
handoff.
The public Node factory exposes this lifecycle-facing handoff while keeping
filesystem, process, archive, HTTP, Git, npm, crypto, and credential adapters
private. It does not choose cache or marketplace paths or perform promotion,
locking, state commit, journaling, rollback, recovery, or collection. Error and
cancellation return no partial handoff and clean materializer-owned writes; a
cleanup failure remains an explicit adapter failure.

Resolved sources retain their immutable URL/path/package fields and revision.
Their `source-v1` canonical form is derived from those fields and the injected
SHA-256 hash is verified before the source is trusted; a kind/canonical/revision
or hash mismatch is rejected.

## Marketplace behavior

| Declaration | Status |
|---|---|
| Root marketplace `name` | Supported; authoritative identity |
| Owner, description, category, tags, interface | Metadata-only |
| Plugin `version` | Supported |
| Claude `strict: true` or omitted | Supported; manifest required, catalog runtime declarations supplemental |
| Claude `strict: false` marketplace authority | Supported; manifest optional, catalog runtime declarations authoritative |
| Codex catalog authority | Supported; manifest required, catalog runtime declarations supplemental |
| Codex installation/authentication policy | Metadata-only except availability |
| Available/installable policy | Supported |
| Not-available policy | Supported |
| Installed-by-default policy | Supported for project synchronization after trust |
| Marketplace plugin renames | Supported |
| Cross-marketplace plugin dependencies | Incompatible |
| Plugin dependency graph and semver constraints | Incompatible |
| Enterprise marketplace restrictions | Incompatible as runtime policy |
| Product-specific visibility restrictions | Metadata-only |

A marketplace entry may declare components and plugin dependencies directly.
Catalog readers retain those raw declarations and their JSON Pointer provenance
without assigning a verdict. After materialization, bundle ingestion applies
the recorded authority and a separate manifest merger; marketplace merging does
not double as manifest merging.

Invalid raw JSON, an invalid root identity/shape, invalid root-wide path
configuration, duplicate surviving names, or conflicting dual root identities
make the catalog root unusable. A malformed entry, malformed nested runtime or
dependency declaration, or dual-entry conflict omits the complete entry and
reports an error while valid siblings survive. Readers check relative path
syntax; realpath, symlink, and containment checks occur against materialized
content.

## Plugin manifests

| Surface | Claude Code | Codex | Status |
|---|---|---|---|
| Manifest path | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` | Supported |
| Manifest required | No | Yes | Both behaviors supported |
| Explicit skills path | Supported | Supported | Supported |
| Conventional `skills/` | Supported | Manifest-oriented | Supported |
| Root `SKILL.md` | Supported | Not conventional | Supported for Claude plugins |
| Hook path or inline hooks | Supported | Supported | Supported subset |
| Conventional `hooks/hooks.json` | Supported | Supported | Supported subset |
| MCP path or inline object | Supported | Supported | Supported subset |
| Conventional `.mcp.json` | Supported | Supported when declared or discovered | Supported subset |
| Claude agents | Supported | Not a plugin component | Retained; not activated |
| Codex apps/connectors | Not a plugin component | Supported | Retained; not activated |
| LSP servers | Supported | Not shared | Retained; not activated |
| Monitors | Supported | Not shared | Retained; not activated |
| Themes and output styles | Supported | Not shared | Retained; not activated |
| Channels | Supported through MCP | Not shared | Retained; not activated |
| Plugin dependencies | Supported by Claude | Not shared | Retained; not activated |

When both manifests exist, equivalent component declarations collapse.
Conflicting declarations of a supported runtime component remain incompatible;
neither manifest wins silently. Presentational metadata (descriptions,
versions, categories, tags, display names) resolves by precedence instead —
marketplace entry, then Claude, then Codex — matching how real hosts treat
metadata drift.

## Supporting plugin configuration

Claude `userConfig` is supported when its values feed a supported skill, hook,
or MCP component. It is compatibility infrastructure rather than a separate
plugin component.

Supported value types are:

- string;
- number;
- boolean;
- directory;
- file;
- string arrays where `multiple` is declared.

Required fields, defaults, numeric bounds, and path validation are enforced.
Production sensitive-value custody is unavailable and fail-closed because no
supported operating-system backend can prove atomic no-replace ownership and
stale-safe deletion. Required sensitive configuration therefore prevents
activation with `SECRET_CUSTODY_UNAVAILABLE`. Plaintext collected through a
masked or headless input boundary is not retained in plugin-host state,
generated MCP configuration, control or terminal output, logs, compatibility
reports, projections, recovery artifacts, or process data.

Configured values are available through:

```text
${user_config.KEY}
CLAUDE_PLUGIN_OPTION_<KEY>
```

A user-configuration construct that cannot be stored or substituted safely is
incompatible.

## Skills

### Supported layouts

- `skills/<name>/SKILL.md`
- manifest-declared skill roots
- one root `SKILL.md` for Claude's single-skill layout
- supporting `scripts/`, `references/`, and `assets/`
- Claude flat command markdown when it is valid as a stable Pi skill command

### Frontmatter

| Field | Status |
|---|---|
| Agent Skills `name` | Supported |
| Agent Skills `description` | Supported |
| `license`, `compatibility`, `metadata` | Metadata-only |
| `disable-model-invocation` | Supported by Pi |
| Codex `agents/openai.yaml` presentation | Metadata-only |
| Codex implicit-invocation policy | Mapped to Pi skill visibility where representable |
| `allowed-tools` | Supported; requires Pi to preserve the same restriction |
| Skill-scoped hooks | Retained; not activated (no skill-activation hook lifecycle) |

Unknown skill frontmatter does not silently gain runtime meaning.

### Names and collisions

Pi uses the skill's declared name. Collision behavior is reported before
activation. A plugin does not replace an existing skill silently.

## Hook handlers

Only command hooks are compatible.

| Hook type or field | Status |
|---|---|
| `type: "command"` | Supported |
| Shell-form `command` | Supported |
| Exec-form `command` plus `args` | Supported |
| `timeout` | Supported |
| `statusMessage` | Supported in interactive Pi modes |
| `shell: "bash"` | Supported where Bash is available |
| `shell: "powershell"` | Supported; requires Windows and PowerShell |
| Tool-event `if` rules | Supported |
| `async` | Retained; hook not activated |
| `asyncRewake` | Retained; hook not activated |
| `type: "http"` | Retained; hook not activated |
| `type: "prompt"` | Retained; hook not activated |
| `type: "agent"` | Retained; hook not activated |
| `type: "mcp_tool"` | Retained; hook not activated |

Matching handlers run concurrently where the foreign contract does. Identical
handlers are deduplicated by their normalized executable form.

## Hook events

| Event | Status | Pi boundary |
|---|---|---|
| `SessionStart` | Supported | `session_start` and post-compaction lifecycle |
| `SessionEnd` | Supported | `session_shutdown` |
| `UserPromptSubmit` | Supported | `input` |
| `PreToolUse` | Supported | `tool_call` |
| `PostToolUse` | Supported | successful `tool_result` |
| `PostToolUseFailure` | Supported | failed `tool_result` |
| `PreCompact` | Supported | `session_before_compact` |
| `PostCompact` | Supported | `session_compact` |
| `Stop` | Supported | settled agent lifecycle plus guarded continuation |
| `SubagentStart` | Supported; requires subagent interception | subagent pre-start interception |
| `SubagentStop` | Supported; requires subagent interception | subagent pre-stop interception |
| `PermissionRequest` | Retained; hook not activated | Pi exposes no equivalent permission-dialog boundary |
| `PermissionDenied` | Retained; hook not activated | no equivalent denial-classifier event |
| `Setup` | Retained; hook not activated | no equivalent setup invocation |
| `UserPromptExpansion` | Retained; hook not activated | no equivalent post-expansion boundary |
| `PostToolBatch` | Retained; hook not activated | Pi exposes completion events per tool, not one blocking batch gate |
| `Notification` | Retained; hook not activated | no equivalent complete notification taxonomy |
| `MessageDisplay` | Retained; hook not activated | no equivalent display-only stream transformation contract |
| `TaskCreated`, `TaskCompleted` | Retained; hook not activated | no portable task lifecycle contract |
| `StopFailure` | Retained; hook not activated | no equivalent classified provider-failure event |
| `TeammateIdle` | Retained; hook not activated | no agent-team equivalent |
| `InstructionsLoaded` | Retained; hook not activated | no equivalent per-instruction load event |
| `ConfigChange`, `CwdChanged`, `FileChanged` | Retained; hook not activated | no equivalent foreign event contract |
| `WorktreeCreate`, `WorktreeRemove` | Retained; hook not activated | no equivalent hook-controlled lifecycle |
| `Elicitation`, `ElicitationResult` | Retained; not activated as hooks | MCP runtime handles elicitation directly |

A plugin declaring any of these events installs; only the affected hooks are skipped, and the skip is reported before activation.

## Hook matcher mapping

Pi preserves foreign matcher intent rather than comparing foreign names against
raw Pi names.

| Foreign name | Pi name or names |
|---|---|
| `Bash` | `bash` |
| `Read` | `read` |
| `Write` | `write` |
| `Edit` | `edit` |
| `Glob` | `find` |
| `Grep` | `grep` |
| `apply_patch` | Pi file-mutation aliases where present |
| `Agent` | configured Pi subagent tool |
| MCP scoped name | plugin-scoped compatibility alias only when the active MCP runtime reports alias support; otherwise unavailable |

Exact-set and regular-expression matcher behavior follows the foreign hook
contract. `Write|Edit`, comma-separated sets, anchored expressions, empty
matchers, and `*` are tested explicitly.

Tool-event `if` rules evaluate against the normalized tool name and input.
Unsupported permission-rule syntax degrades the hook to metadata-only (the hook is skipped, not the plugin).

## Hook input

Supported events receive:

```text
session_id
transcript_path (when the Pi session is persisted)
cwd
hook_event_name
```

An in-memory or `--no-session` Pi session omits `transcript_path` rather than
inventing a path. Pi-only persistence, lifecycle, cancellation, and tool-result
evidence is namespaced under `pi` and never changes the foreign fields.

Event-specific inputs include the applicable foreign fields, such as:

```text
source
prompt
tool_name
tool_input
tool_response
tool_use_id
error
is_interrupt
trigger
agent_id
agent_type
last_assistant_message
stop_hook_active
```

Pi-specific fields may be added under a namespaced object. They do not replace
or alter foreign fields.

`permission_mode` is derived only when Pi exposes an equivalent approval state;
otherwise it is omitted rather than fabricated.

## Hook output

| Behavior | Status |
|---|---|
| Exit `0` success | Supported |
| Exit `2` event-specific block or feedback | Supported where the event can represent it |
| Other exit as non-blocking error | Supported |
| Plain stdout context for `SessionStart` | Supported |
| Plain stdout context for `UserPromptSubmit` | Supported |
| `additionalContext` | Supported |
| `systemMessage` | Supported |
| `decision: "block"` | Supported on mapped events |
| `permissionDecision: "allow"` | Supported |
| `permissionDecision: "deny"` | Supported |
| `permissionDecision: "ask"` | Supported in interactive modes; deny with explanation otherwise |
| `permissionDecision: "defer"` | Incompatible |
| `updatedInput` | Supported on `PreToolUse` |
| `updatedToolOutput` | Supported on `PostToolUse` |
| `continue: false` | Supported where Pi can stop the current lifecycle |
| `stopReason` | Supported |
| Session title update | Supported |
| `terminalSequence` | Incompatible |
| `watchPaths` | Incompatible |
| persisted `CLAUDE_ENV_FILE` mutations | Incompatible |
| dynamic skill reload requested by hook output | Incompatible |

Unsupported output returned at runtime produces an explicit hook compatibility
error; it is not accepted as a no-op.

## Session-source mapping

| Pi lifecycle | Foreign `SessionStart.source` |
|---|---|
| process startup | `startup` |
| new or cleared session | `clear` |
| resumed session | `resume` |
| forked session | `startup` |
| completed compaction | `compact` |
| plugin-host reload | `startup` |

`PreCompact` and `PostCompact` also fire around compaction with `manual` or
`auto` triggers.

## Plugin path environment

Every supported plugin hook and standard-I/O MCP process receives:

```text
CLAUDE_PLUGIN_ROOT=<immutable installed revision>
PLUGIN_ROOT=<immutable installed revision>
CLAUDE_PLUGIN_DATA=<persistent plugin data directory>
PLUGIN_DATA=<persistent plugin data directory>
CLAUDE_PROJECT_DIR=<trusted project root>
```

Placeholders in command, argument, environment, working-directory, URL, and
header fields resolve from the same values.

Plugin root is read-only application content. Plugin data is writable and
survives updates.

## MCP configuration shapes

Pi accepts:

- Claude wrapped `{ "mcpServers": { ... } }`;
- Codex wrapped `{ "mcp_servers": { ... } }`;
- Codex direct server maps where its plugin format permits them;
- inline manifest server objects;
- manifest paths to `.mcp.json`.

## MCP server compatibility

| MCP construct | Status |
|---|---|
| Standard-I/O `command` | Supported |
| `args`, `env`, `cwd` | Supported |
| Streamable HTTP `url` | Supported |
| Static headers | Supported |
| Environment-backed headers and bearer tokens | Supported |
| OAuth authorization-code flow | Supported; requires the MCP runtime capability |
| OAuth client-credentials flow | Supported; requires the MCP runtime capability |
| Startup and tool timeout | Supported |
| Tool allow/deny lists | Supported |
| Tool approval policy | Supported; requires the MCP runtime capability |
| Server instructions | Supported |
| MCP sampling | Supported; requires the MCP runtime capability |
| Form and URL elicitation | Supported; requires MCP runtime support and an interactive Pi UI mode |
| Resources | Supported through MCP runtime |
| Explicit legacy SSE transport | Retained; server not activated (no faithful runtime capability) |
| WebSocket transport | Retained; server not activated |
| Dynamic `headersHelper` command | Retained; server not activated (no faithful runtime capability) |
| Claude channels | Retained; not activated |

Each named MCP runtime capability is checked before activation. An unavailable
requirement prevents activation while preserving the component's `supported`
verdict and reports the missing capability explicitly.

## MCP identity and tool names

A bundled server has a scoped identity derived from:

```text
<plugin-name>@<marketplace-name> + <native-server-key>
```

Canonical source-qualified MCP discovery and calls are available through the
maintained runtime and remain collision-safe across plugins. That runtime
reports foreign tool aliases unavailable, so Plugin Host omits alias mappings
and reports `RUNTIME_ALIAS_UNAVAILABLE`; it does not fabricate Claude-style
names such as:

```text
mcp__plugin_<plugin-name>_<server-name>__<tool-name>
```

Codex and Pi-native discovery remain available through the runtime's canonical
MCP surface. A plugin whose skill or hook requires an exact foreign MCP alias is
incompatible unless a future qualified runtime reports alias support and can
expose the mapping without collision.

## Whole-plugin behavior

- Install activates every supported declared component.
- Disable deactivates every component.
- Enable restores every component from the installed revision.
- Update replaces every component atomically.
- Uninstall removes every active projection.
- Persistent data is removed only after explicit confirmation.
- Individual components are not selected or disabled through Plugin Host.

A plugin declaring an incompatible runtime component does not activate.

## Update behavior

Pi performs non-blocking, rate-limited availability checks for every configured
remote marketplace. Notification does not depend on automatic-update settings.

Each newly discovered plugin revision produces one notification containing:

- plugin identity;
- installed version or revision;
- available version or revision;
- automatic or manual disposition.

Per-marketplace automatic updates control application, not discovery.
Automatic activation applies only to compatible revisions from the unchanged
trusted source identity.

Network, validation, compatibility, trust, and activation failures preserve the
active revision.

## Foreign-state adoption

| Source | Read behavior |
|---|---|
| Claude `known_marketplaces.json` | Discover marketplace source declarations |
| Claude `extraKnownMarketplaces` settings | Discover marketplace source declarations |
| Codex `[marketplaces]` config | Discover marketplace source declarations |
| Claude installed-plugin cache | Not read for activation |
| Codex installed-plugin cache | Not read for activation |
| Foreign trust or credentials | Never imported |

Adoption copies selected marketplace source declarations into Pi-owned state.
It never modifies foreign files and never makes foreign caches available at
runtime.

## Explicit non-goals

The compatibility contract excludes:

- foreign model-provider behavior;
- foreign permission systems;
- enterprise policy enforcement;
- hosted Codex apps or ChatGPT plugin state;
- Claude agents and agent teams;
- LSP integration;
- theme and output-style integration;
- background monitors;
- bidirectional foreign-state synchronization;
- partial plugin installation.

## Authoritative references

- Claude plugin discovery:
  <https://code.claude.com/docs/en/discover-plugins>
- Claude marketplace format:
  <https://code.claude.com/docs/en/plugin-marketplaces>
- Claude plugin manifest and components:
  <https://code.claude.com/docs/en/plugins-reference>
- Claude hooks:
  <https://code.claude.com/docs/en/hooks>
- Claude MCP:
  <https://code.claude.com/docs/en/mcp>
- Codex plugins:
  <https://developers.openai.com/codex/plugins>
- Codex plugin construction:
  <https://developers.openai.com/codex/plugins/build>
- Codex hooks:
  <https://developers.openai.com/codex/hooks>
- Codex MCP:
  <https://developers.openai.com/codex/mcp>
- Agent Skills specification:
  <https://agentskills.io/specification>
- Pi packages, skills, and extensions:
  the documentation distributed with `@earendil-works/pi-coding-agent`
