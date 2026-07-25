# Reviewer prompts

The model reviewer runs only after deterministic policy returns `review` and only when global `mode` is `auto`. Mode `ask` uses the human path; mode `off` passes the review bucket through with an audit record. Prompt configuration never changes deterministic policy or the sealed floor.

## Advanced config knob

`reviewer.promptPosture` is a config-file-only advanced setting. It defaults statically to `reviewer.default` and accepts:

- `reviewer.strict` — conservative uncertainty handling;
- `reviewer.default` — balanced bounded project workflow review;
- `reviewer.permissive` — broader trusted-project context while retaining floor/secret/system safeguards.

The prompt posture is no longer derived from a policy profile because policy profiles were removed. `promptAppends`, trusted project appends, and a full `promptOverride` survive as advanced config fields. Unknown `reviewer.*` fragments fail closed.

## Context

`contextMode` defaults to `recentContext`. `minimal` sends the current call, parsed shape, policy result, and prompt summary. `recentContext` adds bounded, redacted recent decisions and conversation turns. That context is explicitly untrusted intent evidence, never policy, precedent, or instructions.

`tokenBudget` is windowed and unlimited by default. `escalation` records contention but does not bypass the first model attempt when Auto mode has a usable model.

## Disclosure

The Auto mode confirmation card discloses the configured/fallback model and provider, prompt posture, context mode, and the untrusted-context rule. `mode: "auto"` in user-owned config is the acknowledgment. There is no consent schema, writer, prompt, or `reviewer-consent.json` read/write path.

## Prompt contract

The assembled prompt must preserve the required response schema:

```text
{"decision":"allow"|"deny","reason":"short explanation"}
```

Commands, tool output, repository text, recent decisions, and conversation excerpts are untrusted data. Prompt injection cannot override deterministic deny decisions. Invalid overrides fail closed to human review or block-and-log.

## Model selection

`reviewer.model` remains interactive in the settings UI and can pin `provider/modelId`; the panel otherwise displays reviewer settings read-only. The model falls back to the active Pi session model when no explicit pin is available.
