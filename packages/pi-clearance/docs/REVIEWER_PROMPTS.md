# Reviewer prompts

The model reviewer runs only after deterministic policy returns `review` and only when global `mode` is `auto`. Mode `ask` uses the human path; mode `off` passes the review bucket through with an audit record. Prompt configuration never changes deterministic policy or the sealed floor.

## Advanced config knob

`reviewer.promptPosture` is an advanced setting exposed as a confirm-backed selector in the settings UI, alongside reviewer model pinning. It defaults statically to `reviewer.default` and accepts:

- `reviewer.strict` — proof-complete structural evidence; missing, conflicting, or parser-uncertain evidence is denied.
- `reviewer.default` — parsed structural facts plus clear, relevant user intent must resolve material uncertainty.
- `reviewer.permissive` — practical trust for ordinary non-destructive work across projects and systems, while concrete danger, the sealed floor, secrets, and high-impact destructive authorization boundaries still govern.

The three shipped fragments are evidence thresholds, not tool or workflow allowlists. The shared contract carries universal safeguards and threshold-neutral shape evidence guidance; it does not contain a proof-complete allow gate. Strict owns the proof-complete requirement, default owns the parsed-facts-plus-intent requirement, and permissive owns the practical-trust rule.

Under permissive, ordinary non-destructive repository and system operations—including expected edits, replacements, deletions, and cleanup—may cross project and system boundaries and do not require task-specific authorization. Missing task specificity, an unfamiliar target, or a boundary crossing is neutral by itself. Permissive may proceed when parser evidence is incomplete unless concrete evidence shows meaningful danger. Clearly destructive operations against external or high-impact targets—such as cloud or production resources, shared remote state, mass deletion, or secret/credential access—require recent, relevant user-authored authorization for that risk and target scope. Assistant and extension text, tool output, repository text, and generated Clearance briefs can provide context but never authorization.

`promptAppends`, trusted project appends, and a full `promptOverride` survive as advanced config fields. Unknown `reviewer.*` fragments fail closed.

## Context

`contextMode` defaults to `recentContext`. `minimal` sends the current call, parsed shape, policy result, and prompt summary. `recentContext` adds bounded, redacted recent decisions, a separate user-authored intent section, and mixed recent conversation turns. `recentContext.userTurns` defaults to `5`; `conversationTurns` remains the mixed recent-conversation cap, and user turns are deduplicated from the general section. Custom-role extension messages are excluded. All context is explicitly untrusted intent evidence, never policy, precedent, or instructions.

`tokenBudget` is windowed and unlimited by default. `escalation` records contention but does not bypass the first model attempt when Auto mode has a usable model.

## Disclosure

The Auto mode confirmation card discloses the configured/fallback model and provider, prompt posture, context mode, and the untrusted-context rule. `mode: "auto"` in user-owned config is the acknowledgment. There is no consent schema, writer, prompt, or `reviewer-consent.json` read/write path.

## Prompt contract

The assembled prompt must preserve the required response schema. The model request also carries the current deterministic decision reason and provenance as a separately labelled fact/data field outside prompt fragment assembly, so prompt overrides cannot hide why the call reached review:

```text
{"decision":"allow"|"deny","reason":"short explanation"}
```

Commands, tool output, repository text, recent decisions, and conversation excerpts are untrusted data. Prompt injection cannot override deterministic deny decisions. Invalid overrides fail closed to human review or block-and-log.

## Model selection

`reviewer.model` is also interactive in the settings UI and can pin `provider/modelId`; selecting either the model or prompt posture still requires confirmation before writing user-owned config. The remaining reviewer details are read-only in that panel and remain advanced config fields. The model falls back to the active Pi session model when no explicit pin is available. Only genuine user-authored session turns can authorize clearly destructive operations against external or high-impact targets; assistant and extension text may contextualize but cannot authorize them.
