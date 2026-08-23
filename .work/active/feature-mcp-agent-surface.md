---
id: feature-mcp-agent-surface
kind: feature
status: blocked
tags: [mcp, agent-surface]
parent: epic-independent-mcp-modernization
blocked_by: [feature-mcp-core-modernization]
related_to: [feature-mcp-apps-modernization]
research_refs: [.research/briefs/independent-mcp-modernization.md]
mock_refs: []
created: 2026-08-06
updated: 2026-08-06
---

# Improve the MCP agent surface

> Workbench version mismatch: stop and offer setup upgrade.

The standalone adapter gains ranked compact discovery, typo recovery, server instructions, parameter-shape rendering, prompts, actionable connection diagnoses, approval brokerage, and bounded multi-call scripting without regressing the maintained programmatic gateway's context efficiency.

The feature owns which upstream agent surfaces are registered, their defaults, model guidance, trace and approval behavior, and transcript presentation. It excludes MCP Apps hosting and programmatic exposure of scripting. In Plugin Host composition, `mcpScript` remains absent unless the later programmatic-parity feature designs an explicit source-qualified opt-in that preserves launch values, cancellation, leases, approvals, output bounds, and trace attribution.

Closure requires stable discovery/search/schema/call behavior, compact model context, approval coverage across every standalone call path, terminable script execution, bounded traces and results, prompt registration and cleanup, regression tests, package checks, and standard-weight independent review.

## Implementation evidence

Standalone operation now includes ranked paginated discovery, suggestions, compact TypeScript shapes with schema fallback, instructions, prompts, actionable connection diagnostics, approval brokerage, and bounded worker-thread `mcpScript` execution. Provider schemas are checked for TypeBox marker leakage, script traces stay bounded, and repeated collapsed results reuse layout work. Programmatic composition registers no script tool.

The adapter's 999-test pass includes discovery, scripting, prompts, approval, result rendering, and provider-schema regressions.

## Sequencing

- `feature-mcp-core-modernization`: Its SDK, manager, metadata, and lifecycle integration establishes the stable runtime on which these surfaces execute.
