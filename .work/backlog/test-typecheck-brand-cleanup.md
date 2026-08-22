---
id: test-typecheck-brand-cleanup
tags: [cleanup, tests]
created: 2026-08-02
updated: 2026-08-02
---

# Test-suite typecheck: branded-type cleanup

> Workbench version mismatch: stop and offer setup upgrade.

`npx tsc -p tsconfig.test.json --noEmit` in `packages/pi-plugins` reports 716
errors across ~130 test files (sampled 2026-08-02). The pattern is uniform:
test fixtures pass plain string literals and inline identity objects where
domain factories require zod-branded types. Dominant brands:
`CanonicalProjectRoot` (~355 mentions), `PluginKey` (~340), `ProjectKey`
(~253), `ContentDigest`, `MarketplaceName`, `SourceHash`.

Why it went latent: nothing runs this typecheck. `npm test` typechecks `src/`
only (`tsconfig.json`); vitest transpiles tests without typechecking; the only
consumer of `tsconfig.test.json` is the e2e config's `typecheck` block, and
the e2e suite does not run in CI (and currently cannot run locally — its
global setup's plain `npm pack` drops workspace-owned bundles inside an npm
workspace, see `scripts/pack-package.mjs` header comment).

The errors predate the staged-updates work (verified identical on main before
that change). The e2e-harness pack-staging issue is related context: fixing it
would make the e2e suite (and its typecheck gate) runnable, which is when
these errors would start blocking.
