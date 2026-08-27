# Pi Plugin Host Architecture

This package is a filesystem adapter with a transient manager, not a lifecycle
database. The implementation has four boundaries:

1. `src/catalog.ts` reads the supported marketplace catalogs and merges valid
   declarations.
2. `src/host.ts` owns the filesystem contract, bounded marketplace refresh,
   direct mutations, sequential batches, and marked updates.
3. `src/runtime-discovery.ts`, `src/hooks.ts`, and `src/mcp.ts` turn one
   filesystem snapshot into Pi resources and runtime registrations.
4. `src/pi/` registers Pi events and commands. Its custom manager projects
   local and catalog data into one terminal component; it is not a persistent
   controller or second authority.

Public `src/index.ts` exports the reusable filesystem/catalog core. Pi-specific
registration is available through the published `./pi` entry.

## Durable layout

```text
<agent-dir>/plugin-host/
├── .check-on-open?
├── marketplaces/<name>/
│   ├── source.json
│   └── checkout/
├── plugins/<marketplace>/<plugin>/
│   ├── .pi-plugin.json
│   ├── .disabled?
│   ├── .auto-update?
│   └── bundle files
└── data/<marketplace>/<plugin>/
```

Presence of the plugin directory is installation. `.disabled` is disablement.
`.auto-update` selects and authorizes startup replacement of that plugin.
`.check-on-open` is only a manager preference. The descriptive receipt is not
authority, and the manager does not persist cursors, selections, progress,
results, errors, or history.

Updates and refreshes materialize to temporary siblings and rename only after
copying and bundle-safety checks succeed. Installed plugin data remains outside
the reproducible bundle and survives update. Old lifecycle state is not
migrated.

## Safety model

A marketplace catalog is untrusted input even though the user chose its source.
Relative plugin paths are lexically contained and realpath-checked because a
catalog-controlled symlink could otherwise expose host files. Every copied
bundle is scanned with `lstat`; any symlink rejects the copy. Catalog bundles
cannot ship host marker files that silently enable or authorize themselves.

Git and hook commands use argument arrays. Hook declarations use one explicit
`/bin/sh -c` boundary because their foreign format is a shell command string.
Hook subprocesses have JSON stdin, bounded output, timeout, and cancellation.
Failures remain local diagnostics rather than host-wide state.

## Load and update model

Before runtime discovery, the extension inspects installed `.auto-update`
markers. If none exist, startup performs no marketplace work. Otherwise it
refreshes each affected marketplace once with bounded network acquisition and
updates only marked plugins whose declared catalog version differs from the
installed receipt. Unversioned entries remain manual. A source or item failure
preserves the installed copy and never prevents activation.

The extension then scans enabled directories once and registers their runtime
surfaces. It does not watch files and has no scheduler. The explicit
`/plugins update-marked` command uses the same grouped seam but force-updates
all marked entries, including unversioned ones, and reloads once after any
success.

## Manager and mutation model

`/plugins` without arguments opens a single custom Pi component from local
files. Installed, Discover, Marketplaces, and Issues are projections over the
host and current catalogs. An optional check-on-open preference starts a
cancellable, bounded refresh after the first local render. Checks update the
projection incrementally while navigation remains available.

Selections use stable `plugin@marketplace` identities and exist only for that
manager session. Confirmed batches resolve those identities against current
truth, run sequentially, retain mixed outcomes, and stop at the next item
boundary when cancelled. The host rescans after each settled item. Successful
runtime changes set one transient reload flag; the command handler reloads Pi
once when the manager closes. Direct mutation commands still reload immediately
after their one successful action.

MCP is intentionally not a source-lifecycle integration. Enabled `.mcp.json`
and manifest declarations are merged, variables are expanded recursively, and
one plain `{ mcpServers }` overlay is passed to the named `createMcpAdapter`
factory. The adapter merges it with normal file discovery and owns MCP
connection behavior.
