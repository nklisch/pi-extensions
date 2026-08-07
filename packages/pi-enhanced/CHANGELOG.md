# Changelog

## v0.1.4

### Changed

- Rebundled `@nklisch/pi-clearance` (now v0.2.2) and `@nklisch/pi-plugins` (now v0.3.4). pi-clearance now ships native engine prebuilds for Windows x64, Windows ARM64, Intel Mac, and Linux ARM64 in addition to the prior Linux x64 and Apple Silicon Mac prebuilds, so the bundle activates on every common dev platform instead of refusing to arm. pi-plugins fixes GitHub issue #2 (the macOS filesystem-capability gate that hard-failed plugin-host startup) and removes the over-engineered filesystem-gate class altogether; see the project principle in `docs/PRINCIPLES.md`.
