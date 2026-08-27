---
release: plugin-manager-peer-resolution-hotfix-2026-08-27
date: 2026-08-27
packages:
  - "@nklisch/pi-plugins@0.6.1"
  - "@nklisch/pi-enhanced@0.2.6"
items: []
---

# Plugin manager peer-resolution hotfix — 2026-08-27

A clean `@nklisch/pi-enhanced@0.2.5` installation could place an empty Pi 0.80 TUI peer directory above the bundled plugin manager. That directory shadowed the host's working TUI package, so importing the new manager failed even though the package had published successfully.

`@nklisch/pi-plugins@0.6.1` now declares Pi coding-agent and TUI 0.82 or newer. npm therefore resolves the manager against the compatible host peer instead of the older peer range retained by another bundled extension. `@nklisch/pi-enhanced@0.2.6` rebundles the corrected package.

## Verification

- The authoritative repository `npm run check` gate passed and packed both patch versions.
- A bundle regression check pins the plugin manager's Pi 0.82+ peer floor.
- A clean temporary consumer installed the packed enhanced bundle beside Pi 0.84.3, resolved `@nklisch/pi-plugins@0.6.1` against the real TUI 0.84.3 package, and imported the compiled Pi extension successfully.
- `pi-tool-display@0.5.0` still advertises a pre-existing Pi peer range ending at 0.80; npm reports that warning under Pi 0.84, but it does not shadow or prevent the plugin manager import.
