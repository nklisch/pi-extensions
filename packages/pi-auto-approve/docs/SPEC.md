# SPEC — Pi Clearance

Pi Clearance is a Pi extension that structurally analyzes tool calls, evaluates a sealed deterministic policy, and dispatches only policy uncertainty to a configurable review path.

## Hard constraints

- The sealed deny floor always evaluates first and cannot be loosened.
- The Rust policy interpreter is pure and total: every call resolves to `allow`, `deny`, or `review`.
- Parser/analyzer uncertainty, unknown tools, invalid config, and ambiguous conflicts fail closed.
- Mode is global-only and is the single behavioral dial: `off`, `ask`, or `auto`.
- Mode changes only dispatch of `review`: Off passes through and audits; Ask prompts a human; Auto uses model-first review with human/block fallback.
- Off still honors floor, user, shipped, repository, and package deny rules.
- Model output resolves one call and cannot edit policy or loosen the floor.
- User-owned global/project config may add policy; repository policy is tighten-only unless Pi reports the project as trusted.
- Package installation makes packs available, not active. Explicit user-owned enablement is required.
- Pre-public migrations are clean cutovers. Removed keys fail strict schema validation; there are no translators or aliases. Trusted TypeScript rule modules are deliberately cut and are never loaded.
- The native engine is distributed as prebuilt Node-API artifacts for Linux x64 glibc and macOS arm64. Installation never runs Cargo; a missing or unsupported artifact fails closed.

## Config

`GlobalConfigSchema` contains `version`, `mode` (default `ask`), `unknownToolPosture`, packs, package/config enablement, reviewer advanced fields, and display preferences. Project overlays contain packs, enablement, project scope, and trusted prompt appends. Repository policy has no mode or posture.

The former policy posture system and reviewer `enabled`/`mode` fields are removed. Reviewer model pinning remains an interactive settings action; other reviewer advanced knobs are config-file-only. The separate reviewer consent schema/file is removed; explicit `mode: "auto"` is the acknowledgment.

## Native boundary

The TypeScript extension resolves config and pack data, then sends JSON-shaped
commands and an opaque compiled-policy handle to the Rust core. Rust owns bash
parsing, tool analysis, path-fact enrichment, matcher IR compilation, policy
composition/evaluation, and replay/adversarial computation. TypeScript retains
corpus acquisition, proposal heuristics, presentation, and Pi I/O.

## Resolution

1. sealed floor;
2. built-in baseline;
3. user-global packs;
4. user-project packs and scope;
5. trusted repository/package inputs.

The baseline is the former default pack set plus `bash.network.read`, `pi.extension.network-research`, and `pi.home.safe`. Individual pack ids flow into provenance; no posture pseudo-pack exists.

## Commands

`/clearance setup`, `/clearance mode [off|ask|auto]`, `/clearance settings`, `/clearance status`, `/clearance packs`, `/clearance scope`, `/clearance tune`, `/clearance why`, `/clearance allow <plain language>`, and `/clearance allow`. The allow handler only hands a deterministic brief to the agent; it does not construct policy or call the reviewer. `/clearance profile` and `/clearance auto` are removed.
