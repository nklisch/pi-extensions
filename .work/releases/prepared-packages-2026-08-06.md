---
release: prepared-packages-2026-08-06
date: 2026-08-06
packages:
  - "@nklisch/pi-clearance@0.2.0"
  - "@nklisch/pi-mcp-adapter@2.20.1-nklisch.0"
  - "@nklisch/pi-plugins@0.3.3"
  - "@nklisch/pi-subagents@18.1.0-nklisch.0"
items:
  - feature-all-packages-minor-release
  - epic-clearance-control-coherence
  - feature-clearance-control-surface
  - feature-clearance-non-bash-opt-in
  - feature-clearance-reviewer-judgment
  - feature-clearance-sparse-config-persistence
  - feature-codex-mcp-config
  - epic-independent-mcp-modernization
  - feature-mcp-core-modernization
  - feature-mcp-agent-surface
  - feature-mcp-apps-modernization
  - feature-mcp-programmatic-parity
  - epic-subagent-upstream-hardening
  - feature-subagent-agent-policy-controls
  - feature-subagent-child-session-compatibility
  - feature-subagent-minor-version-bump
  - feature-subagent-model-runtime-visibility
  - feature-subagent-result-lifecycle-hardening
  - feature-subagent-upstream-polish
  - story-remove-plan-subagent
  - story-subagent-orchestration-guidance
---

# Prepared package release — 2026-08-06

## Pi Clearance 0.2.0

Clearance now defaults non-Bash harness tools to complete bypass with explicit exact-name gating available through settings. The reviewer uses distinct evidence postures; permissive applies practical trust to ordinary non-destructive work across projects and systems while retaining authorization requirements for clearly destructive external or high-impact actions. `/clearance allow` uses provenance-safe custom messages, deterministic review evidence reaches the model independently of prompt overrides, and setup/settings/status/pack rendering are coherent.

User configuration is now sparse: runtime defaults are no longer materialized into config files. Settings and pack writers persist only non-default choices. Package installation repairs existing global and project overlays atomically with backups, resets invalid or obsolete files to the current version-only baseline, reports symlink skips, and fails visibly on repair errors. Node.js 22.18 or newer is required.

This is an intentional behavioral break: non-Bash typed tools are not Clearance-gated unless explicitly named in `gatedTools`, and installation rewrites existing non-symlinked Clearance config files into sparse canonical form.

## Pi subagents 18.1.0-nklisch.0 and Pi plugins 0.3.3

The maintained subagent fork incorporates selected upstream lifecycle, child-session, policy, result-retention, compatibility, and presentation improvements while preserving fork-specific contracts. Model/runtime visibility is consistent across operator surfaces, queued and resumed work has stable lifecycle behavior, custom agent resolution is explicit, and inherited child tools remain bounded. Pi plugins carries the synchronized exact sibling version and source-load receipt.

## Pi MCP adapter 2.20.1-nklisch.0

The prepared adapter includes current Codex TOML MCP discovery and normalization, retained legacy JSON fallback, and the independently completed runtime modernization already present on `main`.

## Verification

- `npm run check`
- Pi Clearance: 190 test files, 2,749 tests
- Pi subagents: 65 test files, 955 tests
- Pi MCP adapter: 96 test files, 999 tests
- Pi plugins: 346 test files, 1,792 tests
- package validation, native builds, bundle checks, npm pack inspection, contract generation checks, and Workbench validation

Publishing completed through the repository's GitHub Actions trusted-publishing workflow with npm OIDC provenance. Already-published workspace versions were skipped.

- Workflow run: https://github.com/nklisch/pi-extensions/actions/runs/31073493403
- Published and registry-verified: `@nklisch/pi-clearance@0.2.0`, `@nklisch/pi-mcp-adapter@2.20.1-nklisch.0`, `@nklisch/pi-plugins@0.3.3`, and `@nklisch/pi-subagents@18.1.0-nklisch.0`.
