---
release: plugin-manager-2026-08-27
date: 2026-08-27
packages:
  - "@nklisch/pi-plugins@0.6.0"
  - "@nklisch/pi-enhanced@0.2.5"
items:
  - feature-plugin-manager-ui
---

# Keyboard-first plugin manager — 2026-08-27

`@nklisch/pi-plugins` restores a polished terminal manager without restoring the removed lifecycle machinery. `/plugins` now opens Installed, Discover, Marketplaces, and Issues views over direct filesystem truth, with search, component details, explicit multi-selection, sequential mixed-result batches, and one Pi reload when the manager closes after runtime changes.

## Update behavior

- Marketplace checks open from local data, run asynchronously with bounded concurrency and timeouts, remain cancellable, and preserve prior checkouts when a source fails.
- `.auto-update` is the per-plugin standing authorization for startup updates. Marked plugins update before activation only when the catalog declares a changed version; unversioned entries and failed sources leave installed copies unchanged.
- `/plugins update-marked` refreshes affected marketplaces once, force-updates every marked plugin including unversioned entries, reports per-item results, and reloads once after any success.
- The manager persists only its optional check-on-open preference. Selection, progress, results, diagnostics, and reload state remain transient.

## Safety and scope

Catalog paths remain contained, symlinks and special files remain rejected, and catalog bundles cannot ship host marker files. Executable installation, update, and enablement remain explicitly confirmed. The manager adds no lifecycle database, scheduler, controller protocol, operation tokens, rollback, project scope, or persistent operation history.

## Review and verification

- A Kimi K3 independent implementation review found no blocking defects. Its three material findings—Escape behavior during checks, first-time clone timeout scope, and missing component/reload journey tests—were corrected before release.
- `@nklisch/pi-plugins`: 26 tests passed with typecheck, build, and compiled package/Pi entry imports.
- The authoritative repository `npm run check` gate passed and packed `@nklisch/pi-plugins@0.6.0` and `@nklisch/pi-enhanced@0.2.5` successfully.
- Wide, narrow, detail, active-check navigation, batch confirmation/result, and reload-on-close behavior were exercised through the real component.

## Publication receipts

Trusted-publishing workflow: [GitHub Actions run 33033722228](https://github.com/nklisch/pi-extensions/actions/runs/33033722228), successful from commit `d40352a` on 2026-08-27.

Registry verification returned each exact version with a SHA-512 integrity receipt:

- `@nklisch/pi-plugins@0.6.0` — `sha512-sO5iC/UMXV0XYTloKkFt0IXrkFd44xtjapPUlD9hmuxJbKqTYb0Mec0ZH44LAGx3Dpy1af0e+nNjC5aQ4Zbb+g==`
- `@nklisch/pi-enhanced@0.2.5` — `sha512-K24pIjAx2Ah6QbSUmplQuQd8076G6U11xtHpl8Y7CV225pIDly1sxO8zbX1bP1xgVcYSX/wXl25Ewknftr0VHQ==`

A registry-downloaded `@nklisch/pi-enhanced@0.2.5` tarball contains `@nklisch/pi-plugins@0.6.0`, and its compiled Pi extension imports successfully with the host peers present. These initial versions were later superseded by the peer-resolution patch recorded in `.work/releases/plugin-manager-peer-resolution-hotfix-2026-08-27.md`.
