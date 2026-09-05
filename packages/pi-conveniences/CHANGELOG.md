# Changelog

## v0.1.3 — 2026-09-04

### Fixed

- Load extra project instructions from Pi’s active event context instead of a nonexistent event field, so workspace changes use the correct `.agents/AGENTS.md`.

## v0.1.2 — 2026-08-23

### Fixed

- Keep delayed context-footer installation and rendering failures inside the footer extension. A stale or failed UI context now degrades the cosmetic footer and stops retries instead of throwing from a timer or render callback.
