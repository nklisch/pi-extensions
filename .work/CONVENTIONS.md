---
owner: workbench
schema: 1
release_mode: summarized
# Optional project overrides—omit to use Workbench defaults:
# interaction: collaborative|checkpointed|autonomous
# rigor: lean|standard|rigorous
# review: inline|fresh|cross-model|convergent
# capability: efficient|adaptive|maximum
# execution: cohesive|adaptive|parallel
# commits: delivery|checkpoint|granular
---

# Workbench Conventions

## Project verification

- `npm run check` — the authoritative gate: package validation, pi-subagents +
  pi-mcp-adapter build, typecheck, tests, builds, and npm pack inspection.
- `npm run validate` — fast manifest/policy check for all workspaces.
- Per-package: `npm test --workspace @nklisch/<name>` or `bun test
  extensions/*.test.ts` inside the package for the bun-style packages.
- Known exception: `pi-plugins` is mid-implementation — 6 test files (7 tests)
  asserting the standalone-repo provenance/lockfile model and in-progress
  native-control behavior are quarantined via `exclude` in
  `packages/pi-plugins/vitest.config.ts`, and its `test:package` acceptance
  lane (compiled imports + real-Pi packed consumer, which exercises the same
  in-progress receipt machinery) is out of the default `test` script but
  still runnable on demand. One file (plugin-operation-view) also fails in
  the standalone repo. Restore both as the rework lands; do not treat their
  assertions as settled truth in the monorepo layout.

## Tags

Not yet recorded.

## Project-specific guidance

- Packages are independently versioned; publishing is manual via the
  **Publish Pi extension** GitHub Actions workflow (npm trusted publishing).
- New packages come from `npm run create:extension -- <name> [description]`,
  not from copying an existing package.
- Foundation truth lives per subproject in `packages/<pkg>/docs/` following
  the house set — `VISION.md` (direction), `ARCHITECTURE.md` / `SPEC.md`
  (design and contract), `decisions/` (ADRs), plus fork policy docs
  (`FORK-MAINTENANCE.md`, `MAINTAINING.md`) where the package is a maintained
  fork. Substantial packages: pi-plugins, pi-clearance, pi-subagents,
  pi-mcp-adapter. Small packages carry no foundation docs until their
  direction becomes non-obvious. Repo-level engineering values live in
  `docs/PRINCIPLES.md`; pi-clearance additionally has its own product-level
  `docs/PRINCIPLES.md`.
- pi-plugins bundles workspace siblings (pi-subagents, and depends on
  pi-mcp-adapter); the root check builds those two first because pi-plugins'
  typecheck and tests consume their built artifacts.
