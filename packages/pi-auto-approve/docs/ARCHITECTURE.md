# ARCHITECTURE — Pi Clearance

```text
Pi tool_call
  -> runtime handler
  -> config/package/scope resolution
  -> structural analyzer
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

At publish time, napi-rs stages `clearance-core.<platform>.node` into the
`pi-auto-approve-linux-x64-gnu` and `pi-auto-approve-darwin-arm64` optional
packages. The loader first supports the repository-local artifact for builds and
then resolves the matching optional package. It never builds Rust during install.

## Policy and dispatch

The handler never skips deterministic policy. `dispatchReview` is the only tri-state seam:

- `off`: return allow, log `reviewer.decision` with `decisionSource: "mode-off-passthrough"`;
- `ask`: human adapter, then block-and-log when unattended;
- `auto`: model adapter, then human adapter, then block-and-log.

Consent is not a runtime state. `mode: "auto"` in explicit user configuration is the acknowledgment and the setup/settings mode confirmation contains disclosure text.

## Settings

The settings read model exposes one mode selector. Reviewer details are read-only except interactive model selection. Briefing/display and reviewer prompt/context/budget/escalation writes are advanced config-file concerns. The baseline explorer uses `inBaseline`; it does not expose policy posture membership.
