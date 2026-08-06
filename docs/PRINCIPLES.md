# Engineering Principles

Project-owned engineering values for the pi-extensions monorepo. Confirmed
during Workbench setup; change them deliberately, not drift-wise.

## Publishing safety

Nothing reaches npm unless it is deliberately shaped for publishing: scoped
`@nklisch`, non-private, complete metadata, inspected tarball contents, and
trusted-publisher provenance from the release workflow only.

### Why

This repository exists to be the single publishing home for all of the
author's Pi extensions. A mis-scoped, accidental, or tampered publish is the
worst failure mode this repo can have — worse than any bug in any package.

### Implications

- Package validation (`scripts/validate-packages.mjs`) is policy, not lint:
  new packages must satisfy it before they can exist in the tree.
- Tarball inspection (`scripts/check-packs.mjs`) runs on every check; what
  ships is reviewed as a first-class artifact, not an afterthought.
- Platform-specific packages are derived from their root manifest, versioned
  exactly with it, built for every declared target, and published before any
  root package that references them.
- Publishing is a manual workflow dispatch from `main`, never a side effect
  of merging or committing.

### Boundaries

Does not forbid experimentation: packages stay unversioned (`0.1.0`) and
unpublished as long as needed. Safety governs the publish path, not the pace
of development.

## Compatibility posture for published surfaces

Published packages have real external consumers — the author's own machines
and any downstream installs. Their public surfaces (extension entrypoints,
registered tools/commands, config file locations, wire protocols) change
deliberately and are communicated through versioning. Everything unpublished
— internal APIs, work-in-progress packages, project-owned schemas — changes
in place with no shims and no v1/v2 parallel versions.

### Why

The repo mixes mature published packages (pi-mcp-adapter, pi-subagents,
pi-plugins) with fresh ones. Treating internal surfaces as compatibility
burdens would freeze design; treating published surfaces as freely mutable
would break real installations.

### Implications

- Renames and breaking changes to published packages are planned, versioned
  events (e.g. pi-auto-approve → pi-clearance before first publish).
- User-facing config paths and data formats of published packages are real
  data: migrations are planned by the agent but approved and executed by the
  user.
- Mid-implementation packages (currently pi-plugins) may break their own
  internals freely until published.

### Boundaries

Packages that have never been published have no external consumers regardless
of how polished they look. The default for anything project-owned is no
compatibility work.

## Tests earn their upkeep

Tests are kept because they catch real regressions at contract and risk
boundaries — parsers, policy engines, pack contents, protocol adapters — not
because coverage looks good. A test that breaks on every refactor without
ever catching a bug gets deleted, not nursed.

### Why

The repo carries very large suites (pi-clearance ~2,700 tests, pi-plugins
~1,700). At that scale, low-value tests are a tax on every change and teach
contributors (human and agent) to ignore failures.

### Implications

- Prefer contract-level and regression-driven tests; be suspicious of tests
  that mirror implementation structure.
- Smoke tests are acceptable for thin extension registration surfaces (the
  bun-tested packages), where the real risk is "tool not registered," not
  logic.
- Supply-chain-sensitive behavior (pack contents, bundled dependencies,
  provenance) warrants exact pinning tests even when they are brittle by
  nature — that brittleness is the alarm working.

### Boundaries

Brittle-by-design pinning tests (registry bytes, packed surfaces) are exempt
from the "breaks on every refactor" deletion rule; they are supposed to
demand attention when bytes change.
