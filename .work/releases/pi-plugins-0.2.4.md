# pi-plugins 0.2.4

2026-07-29

## Outcomes

- **remove-sqlite-identity-machinery** — Removed the sqlite file-identity
  machinery from every plugin-host adapter (scope lock, lifecycle state,
  transition journal, revision leases, revision retention): `.identity`
  markers, `.initializing` claims, root identity markers, device/inode
  validation, hard-link handle aliases, and per-transaction root
  re-verification. Schema first use now serializes inside one exclusive
  SQLite transaction; the scope lock is the held `BEGIN IMMEDIATE`
  transaction.
- **scope-lock-device-drift** — Diagnosed the `update all` failure that
  motivated the removal: after a reboot, btrfs reassigned the lock database's
  device number and every scoped mutation failed with `ADAPTER_FAILED`.
  Superseded by the full removal above; shipped together.

## Operational notes

- Routine reboots/remounts on btrfs and overlayfs no longer break plugin
  mutations or host startup.
- Marker files written by older versions (`.identity`, `.initializing`,
  `.handle-*`, root markers) are inert debris; no state migration or cleanup
  is required.
- Journal rows stranded as `prepared` by the failed runs are abandoned
  automatically by recovery after the owner-death grace period.

## Verification

- `npm run check` (full gate) passed.
- The full mutation path was exercised against a pre-existing live host
  directory containing old markers.
