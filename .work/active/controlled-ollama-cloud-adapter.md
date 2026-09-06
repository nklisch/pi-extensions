---
id: controlled-ollama-cloud-adapter
kind: feature
status: active
tags: [reliability, provider]
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
created: 2026-08-30
updated: 2026-08-30
---

# Control Ollama Cloud request bursts

Build a local Ollama Cloud provider package that replaces the third-party adapter under the existing `ollama-cloud` provider id.

## Boundary

The package owns Ollama Cloud model registration, OpenAI-compatible streaming, cross-process request limits, quota-error normalization, local audit records, and operator status/reset commands. It uses a checked-in model catalog so routine startup and model selection do not fan out into per-model metadata requests.

The package does not publish to npm, install itself into the user settings, change Ollama account limits, or change Pi's general retry policy. It does not add Ollama web-search tools.

## Accepted behavior

- Existing `ollama-cloud/<model>` references can move to the local package without provider-id migration.
- The adapter shares request and token budgets across concurrent Pi processes.
- Default limits stop a repeat of the observed burst while remaining configurable or fully disableable.
- Rate limits queue for a bounded period. Hard budgets stop with a clear non-retryable error.
- Ollama's exhausted-session response does not trigger Pi's generic automatic retry loop.
- Request records contain timing, model, session identity, outcome, and usage. They never contain prompts, tool arguments, responses, or credentials.
- A command shows current limits and counters. A reset command clears the local window state.
- Model calls retain cancellation, tool calling, thinking controls, streaming usage, and Pi's standard OpenAI-compatible conversion.

## Design

Wrap Pi AI's maintained OpenAI Chat Completions stream instead of copying its protocol parser. An outer stream reserves a request through a file-backed governor, forwards all stream events, records terminal usage, and rewrites only known exhausted-quota errors.

The governor uses a short atomic-directory lock around one JSON state file in the Pi agent directory. Admissions are global across processes. Old request history and abandoned in-flight leases expire during each transaction. Configured request-rate pressure waits until the rolling window opens. Concurrency, rolling request totals, rolling input-token totals, and per-session tool-loop totals enforce hard bounds.

The provider ships a static catalog generated from Ollama's public model metadata. Catalog updates are explicit repository changes. This removes the upstream adapter's one-list-plus-one-request-per-model refresh path from normal operation.

## Closure evidence

- Package tests cover rolling-window admission, cross-session totals, stale-lease cleanup, token and tool-loop limits, quota normalization, stream forwarding, and config validation.
- The package type-checks and passes the repository's authoritative `npm run check` gate.
- A local isolated Pi smoke lists the replacement provider without contacting model-detail endpoints.
- One independent cross-model review has no unresolved blocking finding.
