---
version: 0.2.2
package: "@nklisch/pi-plugins"
date: 2026-07-28
items: [pi-plugins-observation-refresh-ux]
---

# pi-plugins 0.2.2

## Outcomes

- **pi-plugins-observation-refresh-ux** — three user-reported fixes:
  - Installs no longer report `recovery-required` when they actually
    succeeded: one degraded plugin (e.g. a trust-invalid hook anywhere in
    the install set) used to poison the shared activation-observation
    batch. Observation failures are now isolated per plugin; the plugin a
    lifecycle operation is settling still fails the operation, and
    structural failures remain fatal.
  - Marketplace refreshes are much faster: plugin probes (one
    materialize+inspect+assess per installed plugin) are skipped when the
    fetched marketplace snapshot is byte-identical and a probe completed
    within 15 minutes (bounded staleness, failures always re-probe), and
    run with bounded parallelism (4) in deterministic order.
  - The plugin manager shows a braille spinner during operations, page
    loads, and detail loads.

Also carries the previously unpublished **0.2.1**: stdio MCP servers
launched by plugins now receive the desktop session environment
(DISPLAY, WAYLAND_DISPLAY, XAUTHORITY, DBUS_SESSION_BUS_ADDRESS,
XDG_RUNTIME_DIR) so GUI-driving servers such as browser automation can
start.

## Verification

- 1789 package tests; full `npm run check` green at dff1269. Cross-model
  review (gpt-5.6-sol): one blocker (unbounded probe-skip could miss
  updates indefinitely) + two should-fix, all fixed and re-verified.
- Root cause for the recovery-required reports was confirmed against live
  host state (journal rows, installed records, hook authority logs) and a
  real-Pi PTY install repro.
- Published to npm as `@nklisch/pi-plugins@0.2.2` via CI trusted
  publishing, dist-tag `latest`.
