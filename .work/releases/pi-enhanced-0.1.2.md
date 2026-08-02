---
version: pi-enhanced-0.1.2
date: 2026-08-02
items: [interpackage-major-only-ranges]
---

# pi-enhanced 0.1.2

The meta-package now follows current nklisch packages instead of an old minor
line.

## What changed

- **Dependency ranges are major-only.** The previous caret ranges
  (`^0.1.18` and friends) lock a 0.x package to its 0.MINOR line, so
  pi-enhanced 0.1.1 bundled pi-plugins 0.1.x (resolving to 0.1.23) even after
  pi-plugins 0.2.x shipped. All six `@nklisch/*` ranges are now `^0`, and a
  fresh install bundles the current pi-plugins, pi-mcp-adapter, and sibling
  packages.

## Compatibility and operations

- No API or manifest-surface change; only dependency metadata moves.
- The repo convention is now recorded in `.work/CONVENTIONS.md`: major-only
  inter-package ranges, with pi-plugins' exact sibling pins (pi-mcp-adapter,
  pi-subagents) as the documented released-together exception.

## Verification

- `npm run check` green, including pi-enhanced's bundle verification against
  workspace-linked siblings; stale nested registry copies pruned from the
  lockfile.
