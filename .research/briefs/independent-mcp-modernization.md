---
id: independent-mcp-modernization
kind: research-brief
summary: Integrate upstream 2.20.1 improvements into the independently maintained MCP adapter while preserving its source-qualified lifecycle and agent-context enhancements.
updated: 2026-08-06
source_handles: [pi-mcp-adapter-2-20-1, pi-mcp-adapter-post-2-20-1]
relationships:
  - type: informs
    target: .work/releases/prepared-packages-2026-08-06.md
  - type: informs
    target: packages/pi-mcp-adapter/docs/VISION.md
---

# Independent MCP modernization

## Decision boundary

Determine how to absorb useful behavior from `nicobailon/pi-mcp-adapter@2.20.1` without making `@nklisch/pi-mcp-adapter` depend on, pin to, or plan retirement around upstream. Preserve the maintained package's source-qualified dynamic lifecycle and its more context-efficient programmatic agent gateway.

## Findings

Upstream 2.20.1 is an extensive runtime evolution rather than an isolated UI patch: 191 commits touch security, transport ownership, session recovery, OAuth storage, MCP SDK v2, discovery, scripting, approvals, prompts, diagnostics, and MCP Apps UI.[pi-mcp-adapter-2-20-1]{1}[pi-mcp-adapter-2-20-1]{2}

The credential-rebinding correction and lifecycle fixes are foundational correctness changes. Applying only visual UI commits would retain avoidable credential and connection risks underneath the newer presentation.[pi-mcp-adapter-2-20-1]{3}[pi-mcp-adapter-2-20-1]{4}

The strongest agent-surface additions are ranked compact discovery, typo recovery, server instructions, parameter-shape rendering, failure diagnoses, and prompts.[pi-mcp-adapter-2-20-1]{5} The scripting surface is valuable for multi-call work but is a second execution interface that must preserve this fork's source identity, late launch values, cancellation, leases, approvals, output bounds, and trace attribution before it can serve programmatic Plugin Host sources.[pi-mcp-adapter-2-20-1]{6}[pi-mcp-adapter-2-20-1]{7}

The MCP Apps changes form one security and interaction cluster; importing them together is safer than selecting cosmetic commits.[pi-mcp-adapter-2-20-1]{8} The same principle applies to the OAuth credential-store migration and its follow-up fixes.[pi-mcp-adapter-2-20-1]{9}

The stable SDK v2 migration and protocol negotiation should be treated as a transport-boundary replacement with qualification against legacy and exact modern servers, not as a dependency-only update.[pi-mcp-adapter-2-20-1]{10}

Upstream now covers native Codex TOML discovery, but it still lacks the source-qualified dynamic lifecycle that Plugin Host consumes.[pi-mcp-adapter-2-20-1]{11}[pi-mcp-adapter-2-20-1]{12}

Four fixes immediately after the release tag close provider-schema, OAuth issuer, permission-owner resolution, scripting-description, and transcript-rendering defects. They are small, independently tested corrections rather than unfinished feature work.[pi-mcp-adapter-post-2-20-1]{1}[pi-mcp-adapter-post-2-20-1]{2}[pi-mcp-adapter-post-2-20-1]{3}[pi-mcp-adapter-post-2-20-1]{4}

## Decision

Use a three-way source integration from the verified 2.11.0 common base to upstream 2.20.1 and the current maintained package, then apply the four reviewed post-release fixes through `08fe82b`. This retains authorship and lets the complete tested upstream runtime evolve as a unit. Resolve conflicts in favor of current fork-owned public contracts and behavior improvements, while adopting generic upstream behavior by default.

After integration, the package remains independently named, versioned, released, documented, and supported. Upstream becomes attributed prior art and an optional future input, not a runtime dependency, release pin, qualification target, or retirement condition.

Partition delivery into independently verifiable features:

1. core runtime, security, SDK, configuration, OAuth, and lifecycle integration;
2. agent discovery, prompts, diagnostics, approvals, and scripting integration;
3. MCP Apps UI modernization and its full trust boundary;
4. programmatic parity for useful agent/UI surfaces where source identity and lease semantics can be preserved.

## Disconfirming evidence

A smaller cherry-pick set would reduce immediate merge conflicts, and upstream's changelog groups several additions by release. However, the inspected changes share manager, configuration, metadata, lifecycle, and UI internals across releases; selectively copying surface commits would require recreating their hidden prerequisites and would be harder to qualify than a common-base three-way integration.

Upstream's static `createMcpAdapter({ config })` can isolate a supplied configuration, which partially overlaps programmatic use. It does not provide exact mutable source ownership, replacement/removal, late launch-value custody, or revision leases, so it does not eliminate the maintained runtime.[pi-mcp-adapter-2-20-1]{12}

## Confidence limits

The integration decision is high confidence because it is grounded in the immutable source range and common Git base. Exact conflict count, test fallout, and whether every new standalone feature should be exposed to programmatic sources remain implementation findings. No claim is made that upstream 2.20.1 is defect-free or that all optional features should be enabled in Plugin Host composition.
