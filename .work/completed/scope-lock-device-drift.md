---
id: scope-lock-device-drift
kind: story
status: completed
tags: [defect]
completed: 2026-07-29
---

# Scope lock identity rejects device drift

`update all` failed persistently with `ADAPTER_FAILED` after reboot because the
scope lock store still pinned file identity by `st_dev` + `st_ino`; btrfs-style
per-mount device numbers made the recorded marker unmatchable. Fixed by
completing the v0.2.3 inode-based identity work in `sqlite-scope-lock.ts`
(inode-only acceptance, device kept as forensic metadata), with a regression
test that fails pre-fix and passes post-fix. `npm run check` passed. Live
installs need no state surgery; stranded `prepared` journal rows are abandoned
automatically after the owner-death grace period.
