---
id: remove-sqlite-identity-machinery
kind: story
status: completed
tags: [defect, cleanup]
completed: 2026-07-29
---

# Remove sqlite identity/marker machinery host-wide

At explicit user direction, removed the file-identity tamper-evidence
machinery from every plugin-host sqlite adapter (scope lock, lifecycle state,
transition journal, revision leases, revision retention): `.identity` markers,
`.initializing` claims, root identity markers, device/inode validation,
hard-link handle aliases, and per-transaction root re-verification. The guards
repeatedly false-positive-broke normal operation after routine reboots on
btrfs/overlayfs while never catching a real replacement. Schema first use now
serializes inside one exclusive SQLite transaction; the scope lock is the held
`BEGIN IMMEDIATE` transaction. Private modes, symlink rejection, the statfs
capability gate, schema/protocol validation, busy retry, and journal row
digests remain. Old marker files are inert debris. `npm run check` passed; the
pre-existing live host directory (with old markers) passes the full mutation
path. Supersedes the strict marker comparisons from 99a4bfa.
