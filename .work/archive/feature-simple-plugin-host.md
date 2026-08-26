---
id: feature-simple-plugin-host
kind: feature
status: completed
owner: workbench
created: 2026-08-26
completed: 2026-08-26
release: simple-plugin-host-2026-08-26
---

# Replace pi-plugins with a filesystem-first plugin host (completed)

Delivered `@nklisch/pi-plugins` 0.5.0 as a direct filesystem-first marketplace and plugin manager. SQLite lifecycle accounting, generations, convergence, leases, schedulers, project synchronization, control protocols, and the custom manager UI were removed rather than migrated. Skills, hooks, and MCP declarations now load directly from enabled installed bundles.

The full outcome, package versions, independent-review fixes, real marketplace exercise, scope reduction, and verification evidence are recorded in `.work/releases/simple-plugin-host-2026-08-26.md`.
