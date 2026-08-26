# Pi Plugin Host Specification

## Scope

Pi Plugin Host manages user-global plugin bundles from Claude Code and Codex
marketplaces. It supports three runtime surfaces: Agent Skills, simple Claude
command hooks, and MCP server declarations. It does not manage project scope,
foreign host state, trust ledgers, updates on a schedule, rollback, repair,
SQLite, schemas/generations/digests, CAS, leases, notices, or a custom manager
TUI.

## Filesystem contract

```text
<agent-dir>/plugin-host/
├── marketplaces/<marketplace>/{source.json,checkout}
├── plugins/<marketplace>/<plugin>/
│   ├── .pi-plugin.json
│   ├── .disabled?
│   └── bundle
└── data/<marketplace>/<plugin>/
```

Marketplace and plugin names are simple filesystem names. Directory presence
means installed. `.disabled` means disabled. `.pi-plugin.json` contains only
human-readable source/version/description information. Plugin data is the one
persistent plugin-owned directory and survives update; removal may explicitly
remove it.

## Marketplaces and catalogs

`marketplace add` accepts GitHub shorthand (`owner/repository`), a Git URL, or
an existing local repository. GitHub and Git sources are cloned; local sources
are copied. Materialization happens in a temporary sibling. The host reads:

- `.agents/plugins/marketplace.json`
- `.claude-plugin/marketplace.json`

The root `name` is the durable marketplace directory name. An explicit plugin
update refreshes that marketplace before replacing the installed copy. If both catalogs
exist, their names must agree. Valid entries from both are merged by plugin
name. Invalid individual entries produce local diagnostics while valid siblings
remain browseable. Supported plugin sources are relative string paths,
`{source: "local", path: "./plugins/example"}`, and straightforward Git or
Git-subdirectory declarations.

Relative catalog paths cannot be absolute, contain traversal, or cross the
checkout through a symlink. Plugin installation resolves the selected catalog
entry and copies the complete bundle to a temporary sibling before renaming it
into `<marketplace>/<plugin>`. Any symlink in the source bundle rejects the
operation: otherwise an untrusted catalog could expose arbitrary host files.

## Runtime

At extension load, enabled plugin directories are scanned directly. Skills are
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

## Commands

```text
/plugins list|status
/plugins marketplace add|list|refresh|remove
/plugins browse <marketplace>
/plugins install|add <plugin>@<marketplace>
/plugins update <plugin>@<marketplace>
/plugins enable|disable <plugin>@<marketplace>
/plugins remove|uninstall <plugin>@<marketplace>
```

Without arguments, a UI session uses Pi's ordinary selection/input/confirmation
controls. Executable installation, update, enablement, and removal require
interactive confirmation or `--yes` in headless mode. Runtime mutations call
`ctx.reload()` and return immediately afterward.
