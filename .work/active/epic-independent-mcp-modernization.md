---
id: epic-independent-mcp-modernization
kind: epic
status: active
tags: [mcp, integration]
parent: null
blocked_by: []
related_to: []
research_refs: [.research/briefs/independent-mcp-modernization.md]
mock_refs: []
created: 2026-08-06
updated: 2026-08-06
---

# Modernize the independent MCP adapter

> Workbench version mismatch: stop and offer setup upgrade.

`@nklisch/pi-mcp-adapter` absorbs the useful runtime, agent-surface, and MCP Apps advances demonstrated by upstream 2.20.1 while remaining an independently owned package with no upstream runtime, release, pinning, or retirement dependency.

The epic preserves the source-qualified programmatic lifecycle, exact replacement and removal, late launch values, runtime leases, schema-on-error, source-qualified cache identity, bounded rendering, integer schema formats, and Plugin Host qualification. It includes core runtime modernization, agent discovery and scripting surfaces, the complete MCP Apps UI trust boundary, and programmatic parity where those surfaces can preserve source ownership. It excludes npm publication and blind behavioral parity where upstream behavior weakens a maintained contract.

Closure requires all feature outcomes to pass package and packed-consumer qualification, the repository `npm run check` gate, standard-weight independent review, research/index validation, and foundation reconciliation.

## Design

**Primary lens:** data, migration, or integration, with security, compatibility, UI/UX, operations, and testing overlays.

### Outcome and constraints

The common 2.11.0 ancestry is used only as an integration mechanism. The resulting source tree is the maintained package's code, versioned and supported independently. MIT attribution and provenance remain intact.

Generic upstream improvements are adopted by default. Fork-owned public contracts and stronger local behavior win conflicts. Standalone configuration and CLI compatibility remain published surfaces. Plugin Host continues to load only the verified `./programmatic` export with foreign file discovery disabled.

### Chosen approach

Perform a three-way source integration from upstream 2.11.0, the current maintained package, and upstream 2.20.1. This preserves complete upstream feature clusters and their tests without turning upstream into a package dependency. Resolve shared-file conflicts at their owning boundary rather than layering compatibility shims.

Deliver four feature outcomes:

1. Core security, configuration, OAuth, SDK v2, transport, lifecycle, and cache modernization.
2. Agent-facing discovery, prompts, diagnostics, approval, and scripting improvements.
3. The complete modern MCP Apps hosting and interaction boundary.
4. Programmatic parity for useful new surfaces, preserving source identity, late value custody, cancellation, leases, and bounded context.

Code and runtime schemas own field-level contracts. `docs/VISION.md` and `MAINTAINING.md` own the independent product and maintenance posture and are reconciled before source integration so they govern conflict decisions. Plugin Host foundations own its package-neutral integration guarantee.

### Alternatives

Cherry-picking selected commits would produce a smaller first diff but split tightly coupled runtime and UI changes from their prerequisites and regression suite. Replacing the package wholesale with upstream would discard the source lifecycle. Keeping a permanent upstream tracking/rebase promise would contradict the owner's independent-product direction.

### Verification

Use upstream's imported regression suite plus existing programmatic and Plugin Host qualification. Verify credential rebinding, exact HTTP transport behavior, legacy compatibility, lifecycle fencing, session recovery, no-source standalone parity, source identity isolation, replace/remove rollback, cancellation, redaction, lease cleanup, output guarding, agent discovery context, MCP Apps authority isolation, package contents, and exact sibling receipts.

### Risks and recovery

The largest risk is a conflict that silently drops fork behavior while tests still exercise only standalone mode. Preserve the existing programmatic tests before integration, keep the source-qualified files as first-class modules, and run downstream conformance after each feature. Each feature lands as a coherent delivery commit. The last qualified feature commit is the rollback point, and publication is the only irreversible step. No user data migration or registry action occurs during the epic.
