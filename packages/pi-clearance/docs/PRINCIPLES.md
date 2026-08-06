# PRINCIPLES — Pi Clearance

Standing principles that govern design and implementation decisions. These outlive any
one feature; when a decision is ambiguous, defer to these.

## 1. Deterministic policy carries the load

Wherever a tool call can be decided deterministically, it should be. Parsed shapes and
rule packs are cheap, reproducible, testable, and auditable. Model
review is a fallback for uncertainty, not the product's center of gravity.

**Implication:** adding or refining a rule pack is preferable to trusting repeated model
judgment on the same command shape.

## 2. Parse structure; do not bless raw shell strings

Bash policy operates on `BashCommandShape`: programs, arguments, stages, operators,
redirects, substitutions, and parser diagnostics. Start-anchored full-command regexes are
not a safety boundary because they miss hidden segments such as `safe && unsafe`, pipe to
shell, stdout redirects, command substitution, and newline-separated commands.

**Implication:** if a policy need cannot be expressed over parsed shape fields, improve
the shape model or keep the command review-gated.

## 3. The broad baseline proves the DSL and reviewer prompt surface

The shipped built-in default policy must be broad enough to be useful and small enough to
audit. The baseline packs and reviewer prompt surface are not examples; they are production
policy/prompt surfaces validated directly through fixtures, replay, and prompt assembly
tests.

**Implication:** new DSL features and reviewer prompt fragments should be justified by real
pack or review-path needs. A matcher or prompt fragment that exists only for theoretical
completeness is premature.

## 4. The deny floor is sealed and non-overridable

Catastrophic, secret-leaking, privilege-escalating, remote-exec, and parser-defeating
patterns live in a sealed floor pack. The floor evaluates before user policy, including
modeled command stages nested in supported compound bodies, and cannot be loosened by
mode, global config, project config, text approval, model output, or the rule-authoring
workflow.

**Implication:** the loader rejects any allow rule that overlaps the sealed floor. If the
user truly wants no gate, they disable the extension; they do not create a policy mode that
pretends the floor is still active.

## 5. Review is the safe default for uncertainty

Parse failure, unsupported shell syntax, invalid config, ambiguous policy conflicts,
opted-in unknown tools, model failure, and missing UI all move toward `review` or
block-and-log. They never become auto-allow by accident.

Non-Bash extension and MCP tools are ungated by default because harness availability is
the host approval boundary. Global `gatedTools` is an exact-name opt-in list with no
wildcards or future-tool consent; Bash is always fully gated and cannot be listed. An
opted-in tool without a registered analyzer uses `unknownToolPosture`, which defaults to
`"allow"` and may be tightened to `"review"` or `"deny"`. The posture does not apply to
absent names, and the next minor release must communicate this intentional typed-tool
protection break.

**Implication:** the interpreter must be pure and total for gated calls: every analyzed
or opted-in unknown input returns `allow`, `deny`, or `review` with a reason; bypasses are
separately audit-visible.

## 6. Policy growth is agent-mediated, Pi-native, and user-approved

The normal improvement path is agent-mediated and always user-gated: analyze the captured
command history, group model review load and repeated friction, propose a data rule,
core matcher design input, project-scope path setting, pack enablement, or reviewer
prompt/config change, replay the
candidate without executing commands, show exactly what would change through Pi UI, ask the
user, write the user-owned overlay/config, and rerun replay. Proposals are available
whenever the agent has evidence — Tune mode is the deep-analysis surface (corpus replay,
family grouping, adversarial cases), not a gate on proposing. Users may hand-edit readable
config, but the product assumes the safer agent-mediated workflow.

**Implication:** model-authored proposals and runtime reviewer decisions are not policy.
They become policy or reviewer configuration only after user approval and schema/overlap
validation.

## 7. Project-specific convenience belongs in user-owned overlays and explicit packs

Project-specific allow rules and package-contributed packs are useful, but repository files
and installed packages should not silently relax policy. User-owned global config and
user-owned per-project overlays may add allows or enable installed packs. Checked-in
repository policy remains tighten-only unless Pi reports the project as trusted. Executable
TypeScript rule modules are cut and cannot affect policy.

**Implication:** a malicious repository cannot approve its own dangerous commands merely by
committing a permissive policy file, and an installed pack package
does not affect decisions until user-owned config enables it.

## 8. Tune evidence is asymmetric

History replay is strong evidence for what causes friction and for catching regressions.
The tune should include every captured command outcome — deterministic allows/denies,
model-reviewed commands, human approvals/denials, and block-and-log outcomes — so it can
see where deterministic policy or reviewer prompting would reduce future model auto-review.
It is weaker evidence for widening policy, because an observed command may have been safe
only in that moment. Tightening rules can be cheap; new allow rules need provenance,
examples, fixture coverage, and user approval.

Tune proposal batches should be sized to evidence and safety. An initial run with a
large backlog may justify several independent changes; a later maintenance run may justify
one or none. The invariant is not "one small proposal". The invariant is that every
accepted change is shown, approved, validated, and replayed.

**Implication:** replay reports should make allow expansions, pack enablement, project-scope
settings, and reviewer-prompt/config changes visually obvious and preserve before/after
corpus deltas.

## 9. Reviewer prompts are configurable but schema-bound

Users can swap shipped reviewer prompt postures, append user-owned guidance, trust
project-local prompt appends, select minimal or recent-context curation, tune temporary
escalation thresholds, or provide a full user-owned override. Those changes affect only the
LLM-backed model reviewer after deterministic policy returns `review`. They cannot
loosen the sealed floor, create permanent policy, or omit the required response schema.

**Implication:** prompt assembly must be inspectable and tested. Recent decisions and
conversation turns are untrusted intent context, not policy. Bad overrides fail closed to
human prompt or block-and-log.

## 10. Observability is load-bearing

Runtime decisions, review outcomes, replay inputs, recent-context excerpts, and applied
policy or reviewer-config changes must be logged or assembled with additive schemas and
redaction. Without provenance, Tune mode cannot explain why a rule exists or what it
changed.

**Implication:** every `allow`, `deny`, and `review` should carry a rule id or a reason for
falling through to review. Conversation excerpts sent to a reviewer should be bounded,
redacted, and clearly labeled as untrusted context.

## 11. Generalize only after a second tool earns it

Bash is the proving ground. Other Pi tools should get analyzers when real history shows
repeated review friction or safety ambiguity, and users must explicitly opt those tools
into Clearance through exact names. The analyzer seam should be simple, but the policy
model should not be warped around hypothetical tools.

**Implication:** implement bash deeply before abstracting the whole product around generic
tool policy.

## 12. One dial, dense by default, detail on demand

The user-facing control surface is a single behavioral mode — `off`, `ask`, or `auto` —
not a matrix of interacting knobs. Advanced configuration may exist in config files, but
it does not appear as parallel dials competing with the mode. Proposals and decisions are
presented as dense, plain-language summaries by default ("these 12 rules allow: …"); exact
rule diffs and replay/adversarial evidence live behind explicit progressive disclosure.
Safety-relevant warnings (sealed-floor overlap, path-scope widening) surface in the default
view regardless of display mode.

**Implication:** new settings, prompts, or proposal surfaces must justify why they cannot
fold into the mode dial or the default summary view. Complexity that only serves rare
configuration lives in config files and docs, not in the primary UI.
