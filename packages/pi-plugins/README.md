# Pi Plugins

`@nklisch/pi-plugins` is a small filesystem-first marketplace and plugin host
for [Pi](https://github.com/badlogic/pi-mono). It installs compatible Claude
Code and Codex plugin bundles, discovers their skills, runs their simple
command hooks, and supplies their MCP declarations to Pi.

## Install

```bash
pi install npm:@nklisch/pi-plugins
```

Then use the concise command surface:

```text
/plugins marketplace add nklisch/skills
/plugins marketplace list
/plugins browse nklisch-skills
/plugins install workbench@nklisch-skills --yes
/plugins update workbench@nklisch-skills --yes
/plugins enable workbench@nklisch-skills --yes
/plugins disable workbench@nklisch-skills
/plugins remove workbench@nklisch-skills --yes
```

The command uses Pi's ordinary select, input, and confirmation dialogs when
invoked without arguments in a UI session. Installing, updating, enabling, or
removing executable plugin content requires confirmation; pass `--yes` for
headless use. Pi reloads after a runtime-affecting mutation.

## Filesystem truth

The host stores no database or lifecycle ledger. Its durable layout is:

```text
<agent-dir>/plugin-host/
├── marketplaces/<name>/{source.json,checkout}
├── plugins/<marketplace>/<plugin>/{.pi-plugin.json,.disabled?,...bundle}
└── data/<marketplace>/<plugin>/
```

A plugin directory is installed; `.disabled` means disabled. The receipt is
descriptive only. Refresh and install/update stage a sibling directory and
rename it into place. Persistent plugin data is not replaced by an update and
is retained by removal unless `--delete-data` is supplied.

Marketplaces accept GitHub shorthand, Git URLs, and local repository paths.
The host reads `.agents/plugins/marketplace.json` and
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
unrelated bundles. SessionStart `hookSpecificOutput.additionalContext` is
injected into the next Pi system prompt.

MCP declarations are recursively expanded for the plugin root, persistent data
root, and project root, then passed as an in-memory `{ mcpServers }` overlay to
`@nklisch/pi-mcp-adapter`. The adapter merges that overlay with the user's normal
file-discovered MCP configuration. Duplicate plugin server names are qualified
by plugin identity.
There is no background network activity. Marketplace refresh runs only when
requested; updating a plugin first refreshes its marketplace, then replaces the
installed copy.

## Development

```bash
npm run typecheck
npm run test:unit
npm run build
npm run test:package
```

Node.js 22.19 or newer is required. The package keeps the bundled
`@nklisch/pi-subagents` Pi resource available through a direct, best-effort
loader; failure of that optional resource does not prevent plugin discovery.

## License

MIT © 2026 Nathan Klisch
