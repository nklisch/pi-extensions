---
owner: workbench
schema: 1
workbench_version: 0.21.0
completed_items: summarize
review_weight: standard
simplification_posture: balanced
autonomy: adaptive
execution_posture: adaptive
---

# Workbench Conventions

## Project verification

- `npm run check` — the authoritative gate: package validation, native engine and dependency-ordered sibling builds, typecheck, tests, builds, and npm pack inspection.
- `npm run validate` — fast manifest/policy check for all workspaces.
- Per-package: `npm test --workspace @nklisch/<name>` or `bun test
  extensions/*.test.ts` inside the package for the bun-style packages.

## Project-specific guidance

- Select available models through live discovery rather than fixed model names.
  Use Kimi K3 only when explicitly requested or approved by the user.
- Implementation review uses adaptive boundaries, including shared reviews where
  useful. Align optional design review once per run. Commit boundaries follow
  meaningful changes, not work-item transitions.
- No additional release gates or Workbench-managed roadmap are configured.
- Packages are independently versioned; publishing is manual via the
  **Publish Pi extension** GitHub Actions workflow (npm trusted publishing).
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
  causing builds or packs to consume the wrong sibling). Update all affected
  manifests before installation and inspect the resolved dependency tree and
  packed contents afterward.

## Overbuilding calibration

These extensions run on personal developer machines and have real npm consumers.
Complexity should protect user data, host stability, useful automation, and
reliable installation rather than imitate a multi-tenant service.

Avoid duplicating Pi's host lifecycle, speculative generic frameworks, permanent
coordination machinery for transient work, and capability allowlists that reject
legitimate environments without measuring the capability they claim to protect.
Credential and private-data protection, bounded and cancellable work, contained
extension failures, public-contract tests, and publishing safeguards justify
complexity because failures affect real sessions and installed packages.

Revisit this calibration when measured failures, substantial durable data,
external consumers, or a changed deployment model demonstrate a concrete need.
