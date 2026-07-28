---
version: 0.2.1
package: "@nklisch/pi-plugins"
date: 2026-07-28
items: [mcp-stdio-display-env-passthrough]
---

# pi-plugins 0.2.1

## Outcomes

- **mcp-stdio-display-env-passthrough** — GUI-driving MCP servers work again:
  - Plugin-launched stdio MCP servers were spawned with a strict whitelist
    environment; with only the MCP SDK's sudo-inspired safe list on top,
    desktop session pointers never reached the child. Browser-automation
    servers (krometrail) died at launch — Chrome aborts with "Missing X
    server or $DISPLAY" and the server reported
    `browser_process_terminated`. Root cause verified against the live MCP
    child process environ and reproduced with a stripped-env Chrome launch.
  - Fix: a documented passthrough list (`DISPLAY`, `WAYLAND_DISPLAY`,
    `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`) is resolved
    from the captured ambient environment for every stdio launch and merged
    into the child environment. Explicit template declarations take
    precedence; absent or empty host values are omitted; credential-agent
    sockets such as `SSH_AUTH_SOCK` remain declaration-only. POSIX-only in
    practice — Windows GUI children need no environment pointers.

## User-facing surface

- No new commands or settings. Stdio MCP servers that spawn graphical
  processes (browser automation, screenshot capture, desktop tooling) now
  reach the user's session without per-plugin template workarounds.

## Verification

- Three new provider tests (passthrough presence, absent/empty omission,
  template-wins precedence); ambient-request assertion updated.
  1787/1787 package tests green; `tsc --noEmit` clean; full `npm run check`
  green including packed acceptance.
- Cross-model review (gpt-5.6-sol): no blockers; one minor accepted
  (docs now describe the variables as capability-bearing session pointers
  rather than security-neutral); one should-fix rejected as moot (Windows
  case-insensitive lookup — the five names are POSIX desktop concepts that
  never resolve on Windows; facade case behavior predates this change).
- Publishing: manual via the **Publish Pi extension** workflow (npm trusted
  publishing).
