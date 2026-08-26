# Pi Plugin Host Architecture

This package is deliberately a filesystem adapter, not a lifecycle database.
The implementation has three boundaries:

1. `src/catalog.ts` reads the two supported marketplace catalog locations and
   merges valid declarations.
2. `src/host.ts` owns the small filesystem contract and explicit clone/copy
   mutations.
3. `src/runtime-discovery.ts`, `src/hooks.ts`, and `src/mcp.ts` turn one load-time
   filesystem snapshot into Pi resources and runtime registrations.

`src/pi/` is the thin host adapter. It obtains Pi's agent directory, registers
`/plugins`, returns skill paths from `resources_discover`, maps Pi lifecycle
events to Claude command hooks, and invokes the MCP adapter. Public
`src/index.ts` exports only the reusable filesystem/catalog core; Pi-specific
registration is available through the published `./pi` entry.

## Durable layout

```text
<agent-dir>/plugin-host/
├── marketplaces/<name>/
│   ├── source.json
│   └── checkout/
├── plugins/<marketplace>/<plugin>/
│   ├── .pi-plugin.json
│   ├── .disabled?
│   └── bundle files
└── data/<marketplace>/<plugin>/
```

Presence of the plugin directory is installation. Presence of `.disabled` is
disablement. The descriptive receipt is not authority. Updates and refreshes
materialize to temporary siblings and rename only after copying and bundle-safety
checks succeed. Old lifecycle state is not migrated.

## Safety model

A marketplace catalog is untrusted input even though the user chose its source:
relative plugin paths are lexically contained and realpath-checked, because a
catalog-controlled symlink could otherwise expose host files. Every copied
bundle is scanned with `lstat` and any symlink rejects the copy. Git and hook commands use argument
arrays; hook declarations use one explicit `/bin/sh -c` boundary because their
foreign format is a shell command string. Hook subprocesses have JSON stdin,
bounded output, timeout, and cancellation. Failures are local diagnostics, not
host-wide state.

## Load and mutation model

The extension scans enabled installed directories once during extension load.
It does not watch files or perform network work in the background. A command
mutation changes the filesystem and calls `ctx.reload()` as its terminal step,
so the next extension instance scans the new truth. Marketplace refresh and
plugin update are explicit commands only.

MCP is intentionally not a source-lifecycle integration. Enabled `.mcp.json`
and manifest declarations are merged, variables are expanded recursively, and
one plain `{ mcpServers }` overlay is passed to the named
`createMcpAdapter` factory. The adapter merges it with normal file discovery and
owns MCP connection behavior.
