# Pi Plugin Host Vision

Make foreign plugin ecosystems useful in Pi without importing their lifecycle
complexity. A user should be able to add a marketplace, inspect its catalog,
install complete bundles, and manage their skills, hooks, and Model Context
Protocol (MCP) servers from one stable terminal surface. Ordinary directories
and marker files should explain current state without a database viewer or
repair command.

The host stays intentionally small:

- filesystem truth that remains inspectable and recoverable with normal tools;
- a transient, keyboard-first manager over direct host operations;
- explicit network checks plus narrowly authorized startup updates;
- clear containment and symlink boundaries around untrusted catalog content;
- load-time runtime discovery with local diagnostics;
- Pi's existing reload, resource, terminal UI, and MCP seams instead of a
  second host architecture.

A per-plugin `.auto-update` marker grants standing authorization for bounded
updates before activation. It does not create a scheduler: only Pi startup,
the open manager, and explicit commands contact marketplaces. Offline sources
and failed items leave installed copies usable.

Future improvements should preserve this boundary. If a feature needs a
scheduler, lifecycle ledger, generated projection, rollback store, operation
tokens, or custom control protocol, it belongs outside this plugin host rather
than being added here.
