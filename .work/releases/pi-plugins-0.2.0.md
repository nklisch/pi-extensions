---
version: 0.2.0
package: "@nklisch/pi-plugins"
date: 2026-07-28
items: [pi-plugins-ux-fixes]
---

# pi-plugins 0.2.0

## Outcomes

- **pi-plugins-ux-fixes** — four user-reported fixes:
  - "Update available" no longer sticks: installed-row decoration now keys
    off unresolved notices only; resolved tombstones (retained by policy)
    stopped re-advertising applied updates.
  - Trust-required verdicts are recoverable in place: new
    `/plugins trust <plugin> --scope X --yes` command, a manager **Trust
    plugin** action, and a session-start prompt ("Trust X again?") when an
    installed plugin's executable content changed outside a managed update.
    Grants re-verify the exact inspected revision and compatibility
    fingerprint against a live reassessment before recording. Activation
    completes on `/reload` (session contexts carry no reload authority).
  - `/plugin` renamed to `/plugins` everywhere (collision semantics
    preserved through pi's name:occurrence suffixing).
  - Manager list rows show `[user]`/`[project]` scope badges; cross-scope
    installs no longer read as duplicates.

## User-facing surface

- New control command `trust.grant`; manager action; session-start TUI
  review (max 3 prompts, bounded detail lookups, headless modes silent).
- `/plugins trust` requires `--yes` non-interactively.

## Verification

- 1784 package tests; full `npm run check` green including e2e acceptance
  at d240b5e. Cross-model review (gpt-5.6-sol): one blocker (grant bound to
  reviewed evidence) + three should-fix + three minor, all fixed and
  re-verified.
- Published to npm as `@nklisch/pi-plugins@0.2.0` via CI trusted publishing
  (OIDC provenance), dist-tag `latest`.
