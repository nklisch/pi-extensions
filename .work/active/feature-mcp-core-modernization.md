---
id: feature-mcp-core-modernization
kind: feature
status: blocked
tags: [mcp, security, integration]
parent: epic-independent-mcp-modernization
blocked_by: []
related_to: []
research_refs: [.research/briefs/independent-mcp-modernization.md]
mock_refs: []
created: 2026-08-06
updated: 2026-08-06
---

# Modernize the MCP runtime core

The maintained adapter integrates upstream 2.20.1's generic security, configuration, OAuth, SDK v2, transport, lifecycle, metadata, and reliability improvements while preserving every fork-owned source-qualified runtime contract.

This feature includes the common-base source merge, conflict resolution for core runtime files, credential rebinding, Codex TOML reconciliation, SDK and package updates, runtime ownership, HTTP recovery and fallback behavior, secure standalone OAuth storage, disabled servers, instructions, output-schema validation, Unix-socket support, and the upstream core regression suite. Agent scripting/discovery policy, MCP Apps journey completion, and new programmatic exposure are separate feature outcomes even when their source prerequisites arrive in the merge. Until those features close, `mcpScript`, MCP Apps hosting, OAuth, and other new executable surfaces remain unavailable in programmatic composition.

Closure requires the adapter build, typecheck, upstream and programmatic tests, packed-package tests, no-source parity, Plugin Host MCP integration tests, exact sibling receipt updates, and no regressions in source replacement/removal, cancellation, redaction, launch-value disposal, runtime leases, or output guarding.

## Design

**Primary lens:** data, migration, or integration, with security, compatibility, operations, and testing overlays.

### Chosen approach

Rewrite `docs/VISION.md` and `MAINTAINING.md` first so conflict resolution follows the owner's independent-product direction rather than the previous retirement policy.

Create a temporary Git integration repository with the immutable upstream 2.11.0 tree as the base, the current package as one branch, and the exact upstream 2.20.1 tag commit `1dbdef96f674410ac37067de70f10a3de3d48d98` as the other, followed by the four reviewed fixes through `08fe82be1d55036d3960c4bb3fa77ed8707f2bca`. Materialize both upstream trees with `git archive`; never depend on the clone's checkout state. Merge there, resolve conflicts deliberately, then copy the merged package tree back without temporary Git metadata. Existing fork-only files remain; upstream additions arrive with their tests. The feasibility merge produces 14 textual conflicts, concentrated in configuration, package metadata, the shared manager, rendering, documentation, and their tests.

Shared manager and type changes must expose the minimal seams needed by `programmatic-runtime.ts` rather than duplicating SDK or transport behavior. Programmatic sources continue to disable legacy SSE fallback, resolve launch values immediately before connection, and qualify process/cache/status identity by exact source revision. OAuth and OS credential storage remain standalone-only; programmatic capability reporting remains false until source-qualified custody and cleanup exist.

The root standalone entry may retain upstream's static `createMcpAdapter({ config, configPath })`. The `./programmatic` entry retains this package's source-qualified `createMcpAdapter` signature and is the only factory Plugin Host imports. A contract test keeps the option types and exports distinct.

Dependency reconciliation replaces `@modelcontextprotocol/sdk` v1 with exact modular `@modelcontextprotocol/client` and `core` v2, adds upstream's keyring, process, and JSON-comment dependencies, retains fork-required Pi/type dependencies, and keeps the newer compatible `smol-toml`. The monorepo root lock remains authoritative; the upstream workspace lock is not imported. The package and packed-consumer gates must cover protocol negotiation, conservative legacy discovery, native keyring installation/failure, and absence of plaintext fallback.

Codex TOML discovery already exists in commit `ca9a2c3`; conflict resolution keeps its user/project precedence and `env_vars` behavior unless the upstream implementation proves stronger under the maintained tests. The package keeps the unpublished release version until the integrated delivery version is selected. Plugin Host's exact sibling pin and receipt change together only after adapter qualification.

### Verification

Run focused config, server-manager, lifecycle, OAuth, output guard, programmatic runtime/extension, and package-manifest tests during conflict resolution. Include modern and conservative protocol fixtures, keyring failure and no-plaintext-fallback tests, root-versus-programmatic factory contract tests, and no-listener/no-script canaries for programmatic composition. Then run the package test and packed-package gates plus relevant Plugin Host MCP integration before the repository-wide gate.

### Risks and recovery

Upstream SDK v2 types and manager behavior may invalidate assumptions in the programmatic seam. Correct the seam against the new manager rather than retaining parallel old transport code. Credential-store tests may depend on native platform availability; preserve fail-closed production behavior and use upstream's isolated test adapters. The pre-integration commit is the rollback point and nothing is published during this feature.

## Implementation evidence

The common-base integration includes the complete upstream 2.20.1 source and tests plus four reviewed fixes through `08fe82b`. Fork seams preserve exact programmatic Streamable HTTP, callback-resolved values, source identity, replacement/removal, leases, output guarding, schema-on-error rendering, Codex layering, and integer formats. Review corrections reject programmatic OAuth, recover stale programmatic HTTP sessions through fresh late values, guard regex search, keep resolved URLs independent of `process.env`, copy compiled runtime assets, and remove cross-transport merge residue.

All 999 adapter tests pass. The packed package, Plugin Host packed contract, and all 26 official MCP conformance scenarios pass. `npm run validate` passes.

## Blocker

The required root `npm run check` reaches unrelated concurrent pi-clearance work and fails six reviewer-prompt assertions. This clears when that owner reconciles its prompt wording and tests, after which the unchanged root gate must be rerun.
