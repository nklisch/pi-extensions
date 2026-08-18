# Changelog

## v0.1.10

### Fixed

- Rebundle `@nklisch/pi-plugins` v0.3.8 so externally installed Pi hosts retain the complete subagent tool family after process restart instead of loading only the separate model-list helper.
- Rebundle `@nklisch/pi-clearance` v0.2.4 with five supported native targets; Windows ARM64 is no longer built or shipped.

## v0.1.9

### Changed

- Rebundle `@nklisch/pi-plugins` v0.3.7 and align the direct MCP adapter dependency with `@nklisch/pi-mcp-adapter` v2.20.1-nklisch.1. The bundle now carries exact subagent thinking-level status and bounded long-session widget updates.

## v0.1.8

### Changed

- Rebundle `@nklisch/pi-model-modes` v0.3.3 with the new independent `straight` behavioral base/preset and `straight` writing style.

## v0.1.7

### Changed

- Rebundle `@nklisch/pi-clearance` v0.2.3 so confirmed mode and settings changes update the active-session footer immediately instead of waiting for another tool call or restart.
- Rebundle `@nklisch/pi-model-modes` v0.3.2 so global mode persistence is visible in autocomplete and the bare `/mode` panel.

## v0.1.6

### Changed

- Rebundle `@nklisch/pi-plugins` v0.3.5 so marketplace registration works on macOS and rejected source additions show actionable reasons instead of the generic “wasn't allowed” result.

## v0.1.5

### Fixed

- Declare and bundle the complete runtime dependency set used by the enhanced package so packed installations resolve every extension without relying on the monorepo dependency tree.

## v0.1.4

### Changed

- Rebundled `@nklisch/pi-clearance` (now v0.2.2) and `@nklisch/pi-plugins` (now v0.3.4). pi-clearance now ships native engine prebuilds for Windows x64, Windows ARM64, Intel Mac, and Linux ARM64 in addition to the prior Linux x64 and Apple Silicon Mac prebuilds, so the bundle activates on every common dev platform instead of refusing to arm. pi-plugins fixes GitHub issue #2 (the macOS filesystem-capability gate that hard-failed plugin-host startup) and removes the over-engineered filesystem-gate class altogether; see the project principle in `docs/PRINCIPLES.md`.
