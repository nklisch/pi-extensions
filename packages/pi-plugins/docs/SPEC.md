# Pi Plugin Host Specification

## Scope

Pi Plugin Host manages user-global plugin bundles from Claude Code and Codex
marketplaces. It supports Agent Skills, simple Claude command hooks, and Model
Context Protocol (MCP) server declarations. It provides direct commands and a
single-pane Pi terminal manager.

It does not manage project scope, foreign host state, trust ledgers, periodic
schedules, rollback, repair, SQLite, schemas, generations, digests, content
stores, leases, notices, operation tokens, or a custom control protocol.

## Filesystem contract

```text
<agent-dir>/plugin-host/
├── .check-on-open?
├── marketplaces/<marketplace>/{source.json,checkout}
├── plugins/<marketplace>/<plugin>/
│   ├── .pi-plugin.json
│   ├── .disabled?
│   ├── .auto-update?
│   └── bundle
└── data/<marketplace>/<plugin>/
```

Marketplace and plugin names are simple filesystem names. Directory presence
means installed. `.disabled` means disabled. `.auto-update` selects and grants
standing authorization to update that installed plugin before activation.
`.pi-plugin.json` contains only human-readable source, version, and description
information. `.check-on-open` stores one manager preference; all other manager
state is transient. Plugin data is the persistent plugin-owned directory and
survives update; removal may explicitly remove it.

Host marker files must be regular files and must not be symlinks. Installation
and update do not copy `.disabled`, `.auto-update`, or `.pi-plugin.json` from a
catalog bundle. Existing disabled and automatic-update state is preserved when
an installed bundle is replaced.

## Marketplaces and catalogs

`marketplace add` accepts GitHub shorthand (`owner/repository`), a Git URL, or
an existing local repository. GitHub and Git sources are cloned; local sources
are copied. Materialization happens in a temporary sibling. The host reads:

- `.agents/plugins/marketplace.json`
- `.claude-plugin/marketplace.json`

The root `name` is the durable marketplace directory name. If both catalogs
exist, their names must agree. Valid entries from both are merged by plugin
name. Invalid individual entries produce local diagnostics while valid siblings
remain browseable. Supported plugin sources are relative string paths,
`{source: "local", path: "./plugins/example"}`, and straightforward Git or
Git-subdirectory declarations.

Relative catalog paths cannot be absolute, contain traversal, or cross the
checkout through a symlink. Plugin installation resolves the selected entry and
copies the complete bundle to a temporary sibling before renaming it into
`<marketplace>/<plugin>`. A failed final rename restores the prior copy; if
restoration itself fails, the error names the retained copy for recovery. Any symlink in the source bundle rejects the
operation because it could expose arbitrary host files.

Grouped refresh deduplicates marketplace names, uses bounded concurrency and a
per-source timeout, accepts cancellation, and reports each marketplace
independently. Failure does not remove the prior checkout.

## Release metadata

Versions are read from `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
then `plugin.json`, using the first nonempty version. Installed bundles fall
back to their descriptive receipt when no manifest declares one; reading an
older receipt does not rewrite it or substitute a newer catalog version.
Malformed or missing optional release metadata does not hide a plugin.

Local catalog entries inherit bundle metadata, with bundle versions taking
precedence over stale catalog versions. Explicit catalog descriptions remain
preferred for discovery. Equivalent entries across native catalogs retain the
first declared value and fill missing metadata from siblings. Browsing uses
local files only: remote source versions remain limited to advertised catalog
metadata until the source is acquired for installation or a marked update check.

## Runtime

Before activation, the extension checks installed `.auto-update` markers. With
no marked plugins, it performs no marketplace refresh. With marked plugins, it
refreshes each affected marketplace once and replaces an installed bundle only
when the candidate bundle declares a different version, falling back to its
catalog version. Remote candidates are acquired with bounded timeout and
cancellation; the inspected candidate is the copy installed. A candidate with
no declared version is skipped unless the update was explicitly forced. Refresh
and item failures preserve installed copies and do not block discovery.

After that pass, enabled plugin directories are scanned directly. Skills are
discovered from directories beneath `skills/` containing `SKILL.md`, plus a
root `SKILL.md`. Hooks are read from conventional `hooks/hooks.json` and a
simple string path in a plugin manifest. MCP is read from conventional
`.mcp.json` and a simple manifest-declared path or object.

The supported command hook events map as follows:

| Claude event | Pi event |
|---|---|
| SessionStart | `session_start` |
| SessionEnd | `session_shutdown` |
| UserPromptSubmit | `input` |
| PreToolUse | `tool_call` |
| PostToolUse / PostToolUseFailure | `tool_result` |
| PreCompact | `session_before_compact` |
| PostCompact | `session_compact` |
| Stop | `agent_end` |

Hook commands receive JSON stdin with `cwd` and event fields. They receive
`PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA`, and
`CLAUDE_PROJECT_DIR`; execution is bounded and cancellable. Nonzero exits,
timeouts, invalid output, and malformed optional declarations stay local to the
plugin. `hookSpecificOutput.additionalContext` from SessionStart is appended to
the next Pi system prompt.

MCP server values are recursively expanded for those same root variables and
passed to the named `createMcpAdapter` factory as one in-memory
`{ mcpServers }` overlay. The adapter merges it with normal file discovery. A
duplicate plugin server name is qualified with a provider-safe
`<plugin>_<marketplace>_<server>` name.

## Manager

`/plugins` with no arguments requires Pi terminal UI mode and opens Installed,
Discover, Marketplaces, and Issues tabs. The first render depends only on local
files. Search, cursor, detail, selection, progress, mixed results, diagnostics,
and the pending-reload flag live only in the component. A theme-native frame
separates it from the surrounding transcript. The body is height-bounded,
selection follows keyboard navigation, and Page Up/Down scrolls long views.
Narrow tab bars keep the active tab named.

Marketplace checks run asynchronously, use the grouped bounded refresh seam,
and can be cancelled without closing the manager. The optional check-on-open
setting defaults off and persists as `.check-on-open`. Narrow layouts keep
checking and reload status visible in the footer. Failed checks remain visible
in Issues for the manager session and are not presented as successful refreshes.
Aggregated runtime diagnostics appear once, with their plugin identity.

`Ctrl+F` focuses search. Space selects stable `plugin@marketplace` identities.
`a` selects all filtered rows. Contextual keys start install, update, enable,
disable, or remove batches.
The manager drops identities that disappeared from current truth, then shows one
confirmation describing the selected count and executable or destructive
effect. Items run sequentially. Failure does not roll back prior success.
Cancellation stops before the next item, and current filesystem truth is
rescanned after every settled item.

Any successful runtime mutation sets a transient reload flag. Closing the
manager reloads Pi exactly once. Marketplace-only changes do not set the flag.

## Commands

```text
/plugins
/plugins list|status
/plugins marketplace add|list|refresh|remove
/plugins browse <marketplace>
/plugins install|add <plugin>@<marketplace>
/plugins update <plugin>@<marketplace>
/plugins enable|disable <plugin>@<marketplace>
/plugins remove|uninstall <plugin>@<marketplace>
/plugins update-marked
```

Direct executable installation, update, enablement, and removal require
interactive confirmation or `--yes` in headless mode. Each direct runtime
mutation reloads Pi after success.

`/plugins update-marked` refreshes each affected marketplace once, force-updates
every marked plugin including unversioned entries, reports per-item success or
failure, and reloads once if at least one update succeeds. The marker already
provides standing update authorization, so the command does not repeat one
confirmation per plugin.
