# ARCHITECTURE — Pi Clearance

```text
Pi tool_call
  -> runtime handler
  -> config/package/scope resolution
  -> exact non-Bash gate check
     -> absent name: audit allow/bypass -> execute
     -> Bash or opted-in name: structural analyzer
  -> sealed floor + baseline + overlays
  -> allow / deny / review
  -> mode dispatch: passthrough / human / model-first
  -> additive audit entry
```

TypeScript owns Pi lifecycle, config I/O, package discovery, settings, audit, and model/human adapters. The Rust native core owns structural parsing, path facts, policy compilation/evaluation, composition, and replay kernels. The boundary is synchronous JSON plus opaque compiled-policy handles; native load failure refuses to arm the extension.

## Module boundaries

- `src/config/` — strict schemas, loader, paths, and confirm-backed config writers.
- `src/packs/baseline.ts` — built-in baseline catalog; `registry.ts` reports `inBaseline` and enablement provenance.
- `src/native/loader.ts` — lazy Node-API loading, platform artifact selection, health checks, and fail-closed diagnostics.
- `src/parse/` — thin native adapters and shape utilities; parser, analyzers, effects, and path facts are Rust-owned.
- `src/policy/` — TypeScript pack authoring/serialization adapters; compilation, composition, overlap, and evaluation are Rust-owned.
- `crates/clearance-core/` — filesystem-free Rust engine for parsing, path facts, matcher IR, policy decisions, composition, replay, and adversarial validation.
- `crates/clearance-node/` — thin napi-rs JSON binding around the Rust core.
- `src/runtime/handler.ts` — native deterministic decision and mode dispatch seam.
- `src/runtime/reviewer.ts` — human/model fallback, Off audit passthrough, prompt/context assembly, escalation, and token budget.
- `src/runtime/config-commands/` — `/clearance mode`, setup, status, settings, packs, scope, Tune, and why.
- `src/replay/` — TypeScript corpus acquisition and proposal/presentation adapters; replay computation is delegated to native kernels.

Release CI builds every declared native target on an appropriate runner, then
stages all six `clearance-core.<platform>.node` artifacts into the existing
`@nklisch/pi-clearance` package. The loader selects the matching bundled artifact
at runtime. Publishing fails unless every declared target is present, preventing a
release that works only on the publisher's host. Installation never builds Rust and
does not create separate platform packages. Clearance defines no npm install
lifecycle hooks and does not read or write user config during package installation.

## Policy and dispatch

The handler resolves config before dispatch. Bash and exact names in global `gatedTools` use the deterministic pipeline; absent non-Bash names short-circuit before analysis/policy, audit an allow/bypass, and execute. `dispatchReview` is the only tri-state seam for opted-in review results:

- `off`: return allow, log `reviewer.decision` with `decisionSource: "mode-off-passthrough"`;
- `ask`: human adapter, then block-and-log when unattended;
- `auto`: model adapter, then human adapter, then block-and-log.

Consent is not a runtime state. `mode: "auto"` in explicit user configuration is the acknowledgment and the setup/settings mode confirmation contains disclosure text.

## Settings

The settings read model exposes compact selector/toggle rows for mode, reviewer model/posture, scope preset and unknown-path behavior, briefing/display controls, and exact gated non-Bash tools. Every mutation uses the existing planner, confirmation, atomic writer, reload, and policy invalidation path. The baseline explorer uses `inBaseline`; it does not expose policy posture membership. Status exposes one concise customization-category line when non-default settings exist.
