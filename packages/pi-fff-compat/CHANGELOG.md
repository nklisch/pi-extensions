# Changelog

## v0.1.3 — 2026-08-23

### Fixed

- Declare only the extension entrypoint in the Pi package manifest so the finder lifecycle helper is not loaded as an extension factory.

## v0.1.2 — 2026-08-23

### Fixed

- Revoke asynchronous finder initialization at session shutdown. A scan that finishes after session replacement is destroyed instead of repopulating the new session with stale finder state.
