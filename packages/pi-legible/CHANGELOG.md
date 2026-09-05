# Changelog

## v0.1.2 — 2026-09-04

### Fixed

- Discard late prose rewrites after cancellation, session replacement, shutdown, or configuration reload so they cannot overwrite messages or leak originals into a new session.

## v0.1.1 — 2026-08-23

### Fixed

- Make rewrite status updates best effort so a stale UI context cannot replace a successful rewrite result or reject the surrounding Pi event.
