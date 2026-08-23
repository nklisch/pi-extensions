---
id: backlog-fs-capability-probe
kind: story
status: active
tags: [reliability, principles]
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
created: 2026-08-23
updated: 2026-08-23
---

# Replace the filesystem magic-number capability gate with a lock behavior probe

> Workbench version mismatch: stop and offer setup upgrade.

## Problem

`verifyLocalFilesystemCapability`
(`packages/pi-plugins/src/infrastructure/state/local-lock-filesystem.ts`)
hard-throws at startup when `statfs.f_type` is outside a per-platform
magic-number allowlist. This is the third variant of the fail-closed guard
category `docs/PRINCIPLES.md` says to remove (v0.2.3 st_dev identity broke
btrfs/overlayfs; v0.2.4 ripped that out; v0.3.3's f_type allowlist broke
macOS APFS). Home on NFS/bcachefs/virtiofs still refuses startup today, with
no override. The named threat is real (SQLite locking corrupts on NFS-class
network filesystems) but a magic-number allowlist is the wrong instrument.

Parked (not promoted) during the 2026-08-22 follow-up batch; user deferred
it then.

## Direction

Delete the `f_type` allowlist. At adapter init, run a real lock probe: open
a scratch sqlite in the state root, `BEGIN IMMEDIATE`, commit, delete —
measures the capability the guard claims to enforce. On probe failure:
warn-and-continue (single-session use on such filesystems works; only
cross-process concurrency is riskier), never refuse; env override for the
pathological case. Probe every startup, no caching (cached capability state
caused the v0.2.3 class). Pin per-platform behavior in tests, never an
either/or test.
