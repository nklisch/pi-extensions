---
id: antigravity-plugin-support
kind: research-brief
summary: Antigravity now overlaps Plugin Host's core surface enough to justify first-class support, but it requires a distinct adapter and a verified source contract rather than being treated as Codex.
updated: 2026-08-15
source_handles: [antigravity-cli-official-plugins, agy-1-1-13-builtin-customizations, agy-1-1-13-runtime-probe]
relationships: [informs:.work/releases/prepared-packages-2026-08-17.md]
---

# Antigravity plugin support

## Decision boundary

Determine whether `packages/pi-plugins` is current with Google Antigravity (`agy`) plugin conventions and whether Antigravity should become a supported foreign plugin format. This investigation compares current Antigravity CLI 1.1.13 behavior and documentation with Plugin Host's existing Claude/Codex boundaries. It does not implement support, redesign unrelated Plugin Host behavior, or claim compatibility for undocumented Antigravity marketplace semantics.

## Bottom line

**Plugin Host is not currently Antigravity-compatible.** It recognizes only `claude` and `codex` provenance, only `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, and only Claude/Codex marketplace authorities. An unchanged Antigravity plugin rooted at `plugin.json` will not enter the inspection plan.

**First-class Antigravity support is now worth pursuing.** Antigravity has converged on the same high-value bundle idea—Agent Skills, synchronous command hooks, MCP servers, and whole-plugin enablement—so most runtime machinery can be reused. Its package boundary is not merely a new filename, however. The manifest location, discovery conventions, hook document and event contracts, rules, custom agents, commands, enablement state, and source lifecycle differ enough that aliasing it to Codex would make provenance and compatibility reporting dishonest.

**Recommended next step:** run a bounded design/qualification feature for an `antigravity` format adapter, using at least one representative real plugin as the demand and conformance fixture before implementation proceeds. Target skills, faithful command-hook events, and MCP only. Inventory rules, agents, commands, and every unknown field as foreign runtime components; an Antigravity bundle that requires one remains incompatible under the existing whole-plugin rule. Do not advertise marketplace compatibility until its catalog and remote-source contract has a reproducible fixture.

Confidence is **high** on the local bundle/runtime overlap and current repository gap, **medium** on the stable manifest contract, and **low** on marketplace/source compatibility because Google's public material does not define it and the bounded probe did not recover it.

## What changed in Antigravity

The current CLI treats plugins as named bundles carrying skills, agents, rules, hooks, and MCP definitions, with list/install/enable/disable/uninstall lifecycle commands.[antigravity-cli-official-plugins]{1} [antigravity-cli-official-plugins]{2} [antigravity-cli-official-plugins]{6} That is materially closer to Plugin Host's product model than older Gemini extension/customization arrangements.

The installed 1.1.13 guide uses the familiar `.agents/` ecosystem:

- plugin directories under `.agents/plugins/`;
- Agent Skills at `skills/<name>/SKILL.md`;
- hierarchical `AGENTS.md` / `GEMINI.md` rules;
- `hooks.json` command handlers;
- wrapped `mcp_config.json` servers;
- `plugins.json` and `skills.json` path registries.[agy-1-1-13-builtin-customizations]{1} [agy-1-1-13-builtin-customizations]{7} [agy-1-1-13-builtin-customizations]{8} [agy-1-1-13-builtin-customizations]{9} [agy-1-1-13-builtin-customizations]{10}

The running validator additionally recognizes custom agents and commands, accepts both nested and flat skill forms, and accepts a manifest default-disabled flag.[agy-1-1-13-runtime-probe]{4} [agy-1-1-13-runtime-probe]{5} [agy-1-1-13-runtime-probe]{6}

**Inference:** Antigravity did not simply adopt one Claude or Codex package format. It assembled a cross-host convention: Agent Skills and `.agents/` paths, a root `plugin.json`, Claude-like grouped tool hooks, Antigravity-specific invocation/stop hooks, and its own lifecycle/config state.

## Fit with Plugin Host

### Strong reuse

1. **Agent Skills:** `formats/agent-skills/skill-reader.ts` is already host-neutral. Antigravity's nested `SKILL.md` shape matches directly, and flat Markdown can be admitted only if it satisfies the same parsed skill contract.
2. **MCP inventory:** `formats/mcp-reader-support.ts` already accepts a wrapped `mcpServers` map and deliberately leaves server declarations opaque for the runtime compatibility layer. Antigravity's basic MCP document therefore needs host provenance and transport qualification, not a new normalized component model.
3. **Whole-plugin lifecycle:** Antigravity persists enablement separately and intends disabling to stop all bundled customizations.[agy-1-1-13-runtime-probe]{8} [agy-1-1-13-runtime-probe]{9} That aligns with Plugin Host's immutable revision, trust, projection, and whole-bundle lifecycle.
4. **Command execution:** Antigravity currently supports synchronous command handlers only.[agy-1-1-13-builtin-customizations]{4} [agy-1-1-13-builtin-customizations]{5} This fits Plugin Host's command-hook runtime better than HTTP, prompt, or asynchronous hook types would.

### Required distinct adaptation

1. **Closed host model:** `src/domain/provenance-location.ts` defines `NativeHostSchema` as only `claude | codex`. Host-order, marketplace authority, diagnostics, metadata keys, merge ordering, and tests all inherit that closed set.
2. **Manifest and plan:** `src/domain/bundle-ingestion.ts` registers only the two hidden-directory manifest paths. `src/application/discovery-plan.ts` contains binary Claude-versus-Codex choices and only grants conventional discovery to Claude. A root `plugin.json`, `skills/`, `hooks.json`, and `mcp_config.json` need explicit Antigravity conventions.
3. **Marketplace ingestion:** `src/application/marketplace-inspection-service.ts` reads only `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`. The latter is currently labeled Codex in domain provenance; a shared `.agents` spelling is not evidence that Antigravity has the same authority or catalog semantics.
4. **Hook envelope:** `src/formats/hook-reader-support.ts` requires a root `{ "hooks": { <event>: [...] } }`. Antigravity uses a root map of named hook definitions, each of which contains event arrays and optional `enabled`. Reusing the normalized `HookComponent` is appropriate; reusing the parser unchanged is not.
5. **Hook behavior:** Antigravity's `PreInvocation`, `PostInvocation`, and `Stop` outputs inject steps and control continuation; pre-tool results add `ask`, `force_ask`, temporary permission overrides, and shallow argument overwrite.[agy-1-1-13-builtin-customizations]{4} [agy-1-1-13-builtin-customizations]{5} [agy-1-1-13-builtin-customizations]{6} Antigravity also runs hooks from the directory containing `hooks.json`, while Plugin Host currently promises the Pi session working directory; Antigravity documents no plugin-root/data environment equivalent.[agy-1-1-13-builtin-customizations]{13} Each event needs an explicit Pi lifecycle, working-directory, environment, and output policy. Similar names are not enough.
6. **Unsupported bundle members:** rules, custom agents, and commands are runtime-bearing. They must be retained and reported as incompatible until Pi Plugin Host can preserve their behavior. Rule trigger semantics are themselves contradictory across the bundled guide.[agy-1-1-13-builtin-customizations]{11} Silently dropping these members would violate `docs/VISION.md` and `docs/SPEC.md`.
7. **Update identity:** Antigravity's documented manifest has no version field, so an adapter cannot assume Plugin Host's manifest-version step applies; update identity may have to fall through to catalog or immutable source revision.[agy-1-1-13-builtin-customizations]{12}
8. **Remote MCP transport:** Antigravity documentation uses one `serverUrl` field for a remote protocol described as SSE in one guide and Streamable HTTP or SSE in another.[agy-1-1-13-builtin-customizations]{14} The adapter must resolve or conservatively report that ambiguity rather than mapping every URL to Plugin Host's Streamable HTTP capability.

## Documentation and contract instability

Google's own sources disagree:

- Public docs require manifest `name`; the installed guide calls it optional; CLI 1.1.13 rejects a missing name.[antigravity-cli-official-plugins]{3} [agy-1-1-13-builtin-customizations]{2} [agy-1-1-13-runtime-probe]{3}
- The public schema forbids extra fields, but its own example adds `$schema`; the advertised schema URL currently returns 404; the CLI accepts `$schema` and `disabled`.[antigravity-cli-official-plugins]{4} [antigravity-cli-official-plugins]{5} [antigravity-cli-official-plugins]{10} [agy-1-1-13-runtime-probe]{5}
- Public docs stage plugins under private CLI application data, while observed installation and the product changelog use shared `~/.gemini/config/plugins/`.[antigravity-cli-official-plugins]{9} [agy-1-1-13-runtime-probe]{7}
- Skill layout is documented both as direct Markdown files and nested `SKILL.md` directories; the validator accepts both.[antigravity-cli-official-plugins]{8} [agy-1-1-13-builtin-customizations]{7} [agy-1-1-13-runtime-probe]{6}
- The CLI advertises `plugin@marketplace`, direct GitHub subpaths, and remote installation, but the public plugin page supplies no catalog or source schema.[antigravity-cli-official-plugins]{7} [agy-1-1-13-runtime-probe]{2} [agy-1-1-13-runtime-probe]{10}
- Antigravity's parent customization guide permits triggered rules, while its dedicated rules page calls the documented standalone rule files always active.[agy-1-1-13-builtin-customizations]{11}
- The same `serverUrl` field is described as SSE-only in the bundled guide and as Streamable HTTP or SSE in broader public MCP documentation.[agy-1-1-13-builtin-customizations]{14}

**Inference:** the running CLI plus revision-bound fixtures should be the qualification oracle for now. Public documentation is useful direction but not precise enough to be the sole parser contract.

## Recommended implementation boundary

### One coherent feature

Create a feature such as **“Admit Antigravity plugin bundles”** with these outcomes:

1. Add `antigravity` as a first-class native host throughout provenance, ordering, diagnostics, manifests, discovery, merger behavior, and public reports. Replace binary host branches with registry-driven lookup while touching them; adding a third host exposes that the current ternaries no longer express the domain.
2. Parse root `plugin.json` using the runtime-observed contract: required non-empty `name`; optional `description`, `$schema`, and `disabled`; preserve unknown fields as foreign runtime declarations unless proven presentation-only.
3. Discover exact Antigravity conventional paths from the finite content index: `skills/`, `hooks.json`, and `mcp_config.json`. Treat `rules/`, `agents/`, and `commands/` as explicit foreign inventory even when no manifest field names them. Disambiguate `.agents/plugins/<bundle>/plugin.json` from Codex's `.agents/plugins/marketplace.json`; the shared parent spelling does not make one discovery authority.
4. Add an Antigravity hook reader for the named-root envelope. Map only events whose stdin, output, ordering, cancellation, and aggregation can be made faithful. An unsupported event or output field produces incompatibility, not a no-op.
5. Reuse the MCP declaration normalizer, then qualify Antigravity's `serverUrl`, stdio, headers/auth, disabled state, and tool filtering against `pi-mcp-adapter` before assigning supported verdicts.
6. Build revision-bound golden fixtures by validating them with `agy plugin validate` and exercising install/enable/disable behavior under an isolated `HOME`. Record the exact CLI version in fixture provenance.
7. Establish one supported acquisition route before exposing the feature. Prefer an officially documented marketplace adapter if Google publishes one. If no catalog contract can be established, return to product requirements: a direct Git/local bundle lifecycle is a possible scope expansion, not an automatic fallback, and declining a user-visible feature until the source contract stabilizes remains valid.
8. Require at least one representative third-party or user-owned Antigravity plugin as a demand and end-to-end conformance fixture before carrying the design into implementation. Format overlap alone justifies qualification, not shipping a cross-cutting host expansion.
9. Update `packages/pi-plugins/docs/VISION.md`, `ARCHITECTURE.md`, `SPEC.md`, and `COMPATIBILITY.md` from “Claude and Codex” to the exact supported Antigravity boundary only after the source and runtime fixtures pass.

### Explicit first-release exclusions

- No Antigravity rules injection.
- No custom-agent/subagent definition emulation.
- No legacy command-to-skill conversion unless invocation semantics are proven equivalent.
- No adoption of Antigravity's installed cache or trust decisions.
- No marketplace claim inferred from `.agents/` naming.
- No partial activation of a plugin whose excluded runtime components are present.

These exclusions preserve the existing product promise: supported components behave faithfully, and unsupported behavior is reported before activation.

## Alternatives considered

### Treat Antigravity as Codex

Rejected. It reduces plumbing but falsifies provenance and fails immediately on root `plugin.json` and named-root hooks. Shared `.agents` paths are convention overlap, not format identity.

### Require Antigravity authors to add Claude/Codex manifests

Rejected as the final product posture. It can be a temporary author workaround, but requiring a foreign plugin to add Pi-supported host metadata contradicts Plugin Host's unchanged-plugin promise.

### Support skills only

Rejected as plugin compatibility. Pi can already discover portable skills through other channels. Calling a whole bundle compatible while dropping its hooks, MCP, rules, or agents would be partial installation under another name.

### Wait for perfect public documentation

Rejected. The core local bundle contract is reproducible in CLI 1.1.13 and the overlap is sufficient to design an adapter. The uncertain marketplace/source surface should be isolated as a qualification gate rather than blocking all format work.

## Disconfirming evidence

Evidence that weakens an immediate full implementation:

1. Google's public contract is internally inconsistent on required fields, allowed properties, install location, and skill shape, and its advertised schema URL returned 404.[antigravity-cli-official-plugins]{3} [antigravity-cli-official-plugins]{4} [antigravity-cli-official-plugins]{5} [antigravity-cli-official-plugins]{8} [antigravity-cli-official-plugins]{9} [antigravity-cli-official-plugins]{10}
2. No fetched primary source specified the marketplace document or remote-source schema. The temporary Claude-marketplace import probe did not establish one.[agy-1-1-13-runtime-probe]{11}
3. Antigravity bundles may include three runtime surfaces outside Plugin Host's current boundary—rules, custom agents, and commands—so many real plugins may remain honestly incompatible after the first adapter ships.[antigravity-cli-official-plugins]{1} [agy-1-1-13-runtime-probe]{6}
4. The repository's current host model is structurally binary rather than registry-driven, so this is a cross-cutting feature, not a small reader addition.

No evidence found reverses the narrower conclusion that first-class format qualification is worthwhile. It constrains the recommendation from “add Agy as another alias now” to “design a distinct adapter, prove it against a representative real plugin, and gate implementation plus marketplace compatibility on that evidence.”

## Implementation handoff opportunity

This brief supports a Workbench feature to qualify and design the bounded adapter above. The first human/product inputs are a representative plugin and the acceptable acquisition route, because they determine whether support is demanded, testable, and user-reachable without broadening Plugin Host from marketplace management into direct bundle-source management. Implementation should follow only if that design closes both gates.
