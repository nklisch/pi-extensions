# Tune mode

Tune mode is toggled with `/clearance tune`. It temporarily exposes structured history, replay, proposal-generation, and adversarial-analysis tools to the agent. It does not silently change runtime policy.

## Always-on vs Tune-only tools

Two tools are always active, in and out of Tune mode:

- `clearance_propose` — validates and batches agent-authored proposal drafts (read-only; imports no writers).
- `clearance_present` — fills approval evidence, renders the batch card, collects explicit user approval, and is the only write path.

Tune mode adds the deep-analysis surface on top: `clearance_status`, `clearance_list_packs`, `clearance_list_history_families`, `clearance_generate_proposals`, `clearance_show_proposal`, `clearance_replay_proposal`, `clearance_validate_pack`, and `clearance_adversarial_cases`. Tune-generated batches flow through the same shared batch cache and the same `clearance_present` card — one format, one approval gate, in or out of Tune.

The batch card is progressive-disclosure: the default view is a dense plain-language summary ("These 12 rules allow: …") plus a one-line evidence status and always-on safety warnings (sealed-floor overlap, path-scope widening). Exact rule diffs, matcher JSON, replay deltas, and adversarial cases render only when the user selects the detail display mode. Approval is approve-all or per-group; when no captured corpus exists, the automated gate fails closed but the card may offer the human an explicit, warned "approve without replay evidence" action — only for genuine no-corpus proposals.

Tune proposals may target user-owned packs, project scope, package enablement, surviving reviewer advanced config, and `mode` suggestions. Proposals must not target removed posture fields, `reviewer.enabled`, or `reviewer.mode`. A mode suggestion uses the same approval-gated card as other config changes.

The safe loop is:

1. inspect complete captured history;
2. replay current policy without executing commands;
3. generate an evidence-sized proposal batch;
4. show exact diffs, warnings, replay deltas, and adversarial cases;
5. get explicit user approval in Pi UI;
6. write only user-owned config;
7. reload, validate, and replay again.

Runtime reviewer decisions are evidence, not permanent policy. Package installation makes packs available but does not enable them; Tune must still show and approve explicit enablement. Installation may compact existing user-owned Clearance config into its sparse form, with a backup before each rewrite, and never creates absent files. Trusted TypeScript rule-module proposals are removed; Tune emits only inspectable data-pack and core-matcher design inputs.

The product interface is Pi-native. Helper executables are plumbing for tests and debugging, not the user's control surface.

`/clearance allow` is the user-initiated entry point: it sends a displayed Pi custom message of type `clearance.allow-request` containing a clearly `[Pi Clearance]`-labelled deterministic authoring brief to the agent (one draft per named family, batches kept focused). Idle sessions trigger a turn; busy sessions queue the message as a follow-up. It never impersonates a user turn and feeds the same `clearance_propose`/`clearance_present` approval pipeline. Tune remains the corpus-evidence batch surface; it sizes proposals from replay history rather than a single user request.
