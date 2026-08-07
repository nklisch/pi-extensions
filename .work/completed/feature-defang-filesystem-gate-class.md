---
id: feature-defang-filesystem-gate-class
kind: feature
status: completed
tags: [security, bug, plugin-host]
parent: null
blocked_by: []
related_to: [backlog-npm-sha1-integrity-fallback]
research_refs: []
mock_refs: []
created: 2026-09-14
updated: 2026-09-14
---

# Defang the over-engineered filesystem-gate class

Fixed the third round of the same anti-pattern in pi-plugins'
filesystem gate (after `st_dev` identity in v0.2.3 and the sqlite
file-identity machinery in v0.2.4): the magic-number `f_type` allowlist
failed closed on every real macOS APFS volume because Node returns a
vestigial `0x1a` on Darwin. Fixes GitHub issue #2.

## Outcome

`verifyLocalFilesystemCapability` is now Linux/Win32/FreeBSD-only — the
platforms where `statfs.f_type` carries a filesystem magic — and a no-op
on Darwin and any platform Node cannot introspect. `ensurePrivateLockRoot`
validates the 0o700 leaf only; the ancestor-walking symlink rejection that
broke OS-managed symlinks like macOS `/tmp → /private/tmp` is gone. The
capability-gate test that masked the regression (it accepted either failure
or success) now asserts host-platform behavior deterministically. Foundation
docs reconciled against the v0.2.4-removed identity markers and the new gate
behavior. The class is encoded as a project principle in `docs/PRINCIPLES.md`
and `AGENTS.md`.

## Closure evidence

- `npm run check` green (1798 pi-plugins tests passing, all workspace builds,
  packs, typecheck).
- New `local-lock-filesystem.test.ts` covers the regression (host does not
  fail closed, ancestor symlinks accepted, leaf symlink rejected, 0o700
  enforced).
- `sqlite-scope-lock.test.ts` capability-gate test rewritten to a
  deterministic assertion.
- Foundation docs (`SPEC.md:558`, `ARCHITECTURE.md:523-526`) describe the
  actual gate behavior; stale identity-marker assertions removed.
- CHANGELOG entry under Unreleased.

## Parked

- npm SHA-1 fallback when SHA-512 is absent
  (`infrastructure/npm/npm-registry-client.ts:187-189`): parked as
  `backlog-npm-sha1-integrity-fallback`. Needs `NpmIntegritySchema`
  widening across the source domain.
