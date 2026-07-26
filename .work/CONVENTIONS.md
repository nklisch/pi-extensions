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
- `pi-plugins` sibling contract: pi-plugins, pi-mcp-adapter, and pi-subagents
  are owned and released together from this repo. The load-time probe
  verifies manifest SHAPE only (name, version, license, engine/peer ranges,
  required exports, declared Pi resources) — no registry SRIs or tree
  digests. Byte integrity is npm's job (lockfile SRIs at install); the
  bundle ships inside pi-plugins' own tarball. A sync-invariant test
  (`test/runtime/published-package-provenance.test.ts`) fails if the
  receipt version, dependency pin, and sibling workspace version diverge —
  bump them together. The subagents lifecycle CONFORMANCE model
  (qualification digests, behavioral vectors) is separate and still intact.

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
- Release-order pitfall: `npm version --workspace` runs `npm install`
  immediately. When bumping a sibling, update pi-plugins' dependency pin in
  the same step before any install runs; if an install runs while pin !=
  workspace version, npm nests the registry copy under
  `packages/pi-plugins/node_modules/` (shadowing the workspace link and
  tripping the load gate with PACKAGE_DRIFT). Fix: prune the nested lockfile
  entries under `packages/pi-plugins/node_modules/`, delete the dir,
  reinstall.
