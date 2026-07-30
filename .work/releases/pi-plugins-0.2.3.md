---
version: 0.2.3
package: "@nklisch/pi-plugins"
date: 2026-07-29
items: []
---

# pi-plugins 0.2.3

## Outcomes

- **Mount-stable file identity** — the host no longer breaks after routine
  reboots on btrfs. btrfs (and overlayfs et al.) assign anonymous `st_dev`
  numbers per mount, so a reboot changed device while files and inodes were
  genuinely unchanged. The host had persisted device+inode in SQLite identity
  markers, recovery journal markers, and the project repository fingerprint,
  which both hard-failed startup (`SQLite database identity marker does not
  match its path`) and rotated project keys every mount epoch, orphaning
  project-scoped state databases. Identity acceptance is now inode-based
  (device remains recorded as forensic metadata; real file replacement still
  allocates a new inode and is rejected), and the fingerprint preimage is v2
  without device. One-time project-key rotation is accepted: v1 keys were
  already per-mount-epoch, so no durable key existed to preserve. User-scope
  state (`user.sqlite`) is fully preserved; previously orphaned per-epoch
  project databases under `plugin-host/state/v1` can be deleted manually.
- **Visible startup causes** — packaged host startup failures now inline the
  underlying cause chain in the extension error message; Pi's extension
  runner prints only `Error.message`, which previously hid the real reason
  behind the bare "packaged plugin host startup failed".

## Verification

- Root cause confirmed against live host state: every marker recorded device
  42 while the post-reboot mount reported 41, inodes identical; diagnosed by
  instrumenting the installed dist to surface the swallowed cause chain,
  then reproducing via real `pi` runs.
- 1794 package unit tests (added: device-drift acceptance and inode-mismatch
  rejection for both stores, v2 fingerprint preimage pinning); typecheck,
  boundaries, packed-package acceptance, and full `npm run check` green at
  3635efa.
- Published to npm as `@nklisch/pi-plugins@0.2.3` via CI trusted publishing,
  dist-tag `latest`; local install refreshed from the registry and verified
  clean on real `pi` startup.
