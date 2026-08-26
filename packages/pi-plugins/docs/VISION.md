# Pi Plugin Host Vision

Make foreign plugin ecosystems useful in Pi without importing their lifecycle
complexity. A user should be able to add a marketplace, inspect its catalog,
install a complete bundle, and find its skills, hooks, and MCP servers on the
next reload. Ordinary directories and marker files should explain the current
state without a database viewer or repair command.

The host stays intentionally small:

- explicit user-requested network operations only;
- filesystem truth that remains inspectable and recoverable by normal tools;
- clear containment and symlink boundaries around untrusted catalog content;
- load-time runtime discovery with local diagnostics;
- Pi's existing UI, reload, resource, and MCP seams instead of a second host
  architecture.

Future improvements should preserve this boundary. If a feature needs a
scheduler, ledger, generated projection, rollback store, or custom lifecycle
protocol, it belongs outside this plugin host rather than being added here.
