# Pi Plugins

`@nklisch/pi-plugins` is a filesystem-first marketplace and plugin manager for
[Pi](https://github.com/badlogic/pi-mono). It installs compatible Claude Code
and Codex plugin bundles, discovers their skills, runs their simple command
hooks, and supplies their MCP declarations to Pi.

## Install

```bash
pi install npm:@nklisch/pi-plugins
```

Run `/plugins` with no arguments to open the keyboard-first manager. It provides
Installed, Discover, Marketplaces, and Issues views; search and plugin details;
and explicit multi-select batches. `Ctrl+F` focuses search, Space selects rows,
`a` selects all filtered rows, Enter opens details, `r` checks marketplaces,
and the footer shows the contextual action keys.

The manager opens from local files. Marketplace checks run asynchronously with
bounded concurrency and timeouts, remain cancellable, and never hide the
installed copies when a source is offline. Runtime changes are applied
sequentially and trigger one Pi reload when the manager closes.

The direct command surface remains available for scripts and focused actions:

```text
/plugins list
/plugins marketplace add nklisch/skills
/plugins marketplace list
/plugins marketplace refresh nklisch-skills
/plugins browse nklisch-skills
/plugins install workbench@nklisch-skills --yes
/plugins update workbench@nklisch-skills --yes
/plugins enable workbench@nklisch-skills --yes
/plugins disable workbench@nklisch-skills
/plugins remove workbench@nklisch-skills --yes
/plugins update-marked
```

Direct installation, update, enablement, or removal of executable plugin
content requires confirmation; pass `--yes` for headless use. Each direct
runtime mutation reloads Pi after it succeeds.

## Automatic updates

An installed plugin can be marked for automatic updates from its detail view.
The `.auto-update` marker is both the selection and the standing authorization
to replace that plugin's executable content.

Before plugin activation, Pi refreshes each affected marketplace once with a
bounded timeout. A marked plugin updates only when the catalog declares a
version different from its installed receipt. Missing versions, offline
sources, and item failures leave the installed copy unchanged and do not block
startup.

`/plugins update-marked` is the explicit escape path. It refreshes affected
marketplaces, force-updates every marked plugin—including unversioned entries—
reports mixed results, and reloads once if any update succeeds. There is no
scheduler or periodic background updater.

## Filesystem truth

The host stores no database or lifecycle ledger. Its durable layout is:

```text
<agent-dir>/plugin-host/
├── .check-on-open?
├── marketplaces/<name>/{source.json,checkout}
├── plugins/<marketplace>/<plugin>/{.pi-plugin.json,.disabled?,.auto-update?,...bundle}
└── data/<marketplace>/<plugin>/
```

A plugin directory is installed; `.disabled` means disabled. The receipt is
descriptive only. `.check-on-open` stores the manager's optional refresh
preference; cursor, selection, progress, results, and errors are never stored.
Refresh and install/update stage a sibling directory and rename it into place.
Persistent plugin data is not replaced by an update and is retained by removal
unless `--delete-data` is supplied.

Marketplaces accept GitHub shorthand, Git URLs, and local repository paths. The
host reads `.agents/plugins/marketplace.json` and
`.claude-plugin/marketplace.json`, merges valid siblings, and supports local
plugin declarations such as `{ "source": "local", "path": "./plugins/demo" }`
and ordinary relative string paths. Catalog paths must remain within the
marketplace checkout. Symlinks are rejected anywhere in a copied plugin tree,
so catalog-controlled content cannot expose arbitrary host files.

## Runtime compatibility

At extension load, enabled bundles are scanned for:

- `SKILL.md` at the bundle root and skills beneath `skills/`;
- command hooks in `hooks/hooks.json` or a simple manifest-declared hook path;
- MCP servers in `.mcp.json` or a simple manifest-declared MCP path/object.

Supported Claude hook events include `SessionStart`, `SessionEnd`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`PreCompact`, `PostCompact`, and `Stop`. Hook processes receive JSON on stdin,
the plugin root/data variables, `CLAUDE_PROJECT_DIR`, a bounded timeout, and
cancellation. Hook failures are reported for that plugin and do not disable
unrelated bundles. `hookSpecificOutput.additionalContext` is delivered on the
same turn as a model-visible, transcript-backed context message; this preserves
per-turn `UserPromptSubmit` digests instead of treating them as lasting system
instructions.

MCP declarations are recursively expanded for the plugin root, persistent data
root, and project root, then passed as an in-memory `{ mcpServers }` overlay to
`@nklisch/pi-mcp-adapter`. The adapter merges that overlay with the user's
normal file-discovered MCP configuration. Duplicate plugin server names are
qualified by plugin identity.

## Development

```bash
npm run typecheck
npm run test:unit
npm run build
npm run test:package
```

Pi 0.82 or newer and Node.js 22.19 or newer are required. The package keeps the bundled
`@nklisch/pi-subagents` Pi resource available through a direct, best-effort
loader; failure of that optional resource does not prevent plugin discovery.

## License

MIT © 2026 Nathan Klisch
