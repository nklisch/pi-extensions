---
release: simple-plugin-host-2026-08-26
date: 2026-08-26
packages:
  - "@nklisch/pi-plugins@0.5.0"
  - "@nklisch/pi-mcp-adapter@2.21.0-nklisch.2"
  - "@nklisch/pi-enhanced@0.2.4"
items:
  - feature-simple-plugin-host
---

# Filesystem-first plugin host — 2026-08-26

`@nklisch/pi-plugins` is now a small filesystem-first plugin manager. Ordinary marketplace checkouts, installed plugin directories, `.disabled` markers, and plugin data directories replace the previous SQLite lifecycle, generations, immutable stores, convergence, leases, schedulers, projections, control protocols, and custom manager UI.

## Runtime outcomes

- Explicit GitHub/Git/local marketplace add, refresh, browse, and removal.
- Explicit plugin install, update, enable, disable, list, and removal through private sibling staging plus rename.
- Direct discovery of skills, Claude command hooks, and MCP declarations from enabled installed bundles.
- Hook subprocess cancellation, timeout, bounded output, JSON stdin, and contained early-pipe failures.
- Plugin MCP servers contributed through the new `pi-mcp-adapter` `configOverlay` option, preserving normal user/project MCP file discovery.
- Path containment, symlink and special-file rejection, explicit executable-content confirmation, and subprocess boundaries retained as the practical safety perimeter.
- Plugin-owned data retained across updates and, by default, removal.

## Scope reduction

The package now contains 12 TypeScript source files (1,696 lines) and five focused test/package fixtures (296 lines). The delivery diff removes more than 128,000 lines, including lifecycle services, SQLite infrastructure, convergence and repair machinery, scheduler/lease code, compatibility surfaces, the custom TUI/control protocol, E2E infrastructure, and implementation-mirroring tests.

## Review and verification

- A different-model independent review identified an unhandled hook stdin `EPIPE` and MCP file-discovery displacement; both were fixed and regression-tested.
- Additional review findings addressed disabled reinstall preservation, clear missing-install errors, catalog/hook diagnostics, provider-safe MCP collision names, flag ordering, `.git` copy omission, and disabled-marker consistency.
- `@nklisch/pi-mcp-adapter`: 99 files / 1,008 tests passed, followed by a clean programmatic build.
- `@nklisch/pi-plugins`: typecheck, nine tests, build, and compiled package/Pi entry imports passed.
- The real stored `nklisch/skills` marketplace was exercised in an isolated agent directory: 13 catalog plugins, Workbench skill and SessionStart hook discovery, Krometrail MCP discovery, explicit update/removal, and zero diagnostics.
- Authoritative root `npm run check` passed and packed all release candidates, including `pi-plugins` 0.5.0, `pi-mcp-adapter` 2.21.0-nklisch.2, and `pi-enhanced` 0.2.4.
- `git diff --check` passed.
