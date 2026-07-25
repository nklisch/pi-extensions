---
name: clearance-tune
description: >
  Agent-facing workflow for reducing Pi Clearance review friction through
  Pi-native Tune mode. The always-on clearance_propose/clearance_present flow
  accepts drafts and owns the approval card; Tune turns on temporary clearance_*
  analysis tools to inspect captured history, size and validate batches, and
  present them through the same card. The helper CLI is internal test/debug
  plumbing, not the approval path.
---

# Clearance Tune

Use this skill when the user wants to reduce repeated Pi Clearance review
prompts, tune policy or reviewer config from captured command history, or
inspect replay evidence for a proposed change.

Tune mode is an approval workflow, not an auto-apply workflow. Runtime reviewer
decisions and model-authored suggestions are evidence only. They become policy
or reviewer configuration only after the user sees the exact proposal card,
approves it through Pi UI, and the write-time validator accepts it.

## Read first

1. [TUNE.md](../../../docs/TUNE.md) — Tune workflow, proposal cards, replay
   evidence, approval, and writer boundaries.
2. [PACK_AUTHORING.md](../../../docs/PACK_AUTHORING.md) — inspectable data packs,
   core matcher gaps, and package-distributed collections.
3. [CONFIGURATION.md](../../../docs/CONFIGURATION.md) — user-owned `packs` and
   reviewer config shape.

## Turning Tune mode on and off

Tune analysis tools are temporary. They are hidden outside Tune mode; the
always-on `clearance_propose` and `clearance_present` tools remain active.

- `/clearance tune` — toggle Tune mode on or off. When on, Pi snapshots the
  current active tools and exposes the Tune analysis tools for this session.
  Invoke it again when the pass is done so temporary analysis tools do not
  linger.

## Required workflow

1. `/clearance tune` to activate Tune mode.
2. Call `clearance_status` first to read Tune mode, baseline packs, reviewer
   configuration, project trust, pack counts, and current warnings.
3. Call `clearance_list_history_families` to inspect captured command history by
   structured family, replay status, captured outcome, source, and evidence
   fidelity. Use `clearance_list_packs` when pack enablement or pack source
   context is relevant to the change.
4. Call `clearance_generate_proposals` to draft a bounded structured proposal
   batch from the captured history. Generation caches the in-memory batch and
   never writes config or policy.
5. For each proposal in the batch:
   - `clearance_show_proposal` to read the exact structured proposal and its
     proposal-card markdown.
   - `clearance_replay_proposal` to dry-run the proposal across captured history
     without executing commands and attach the structured replay delta.
   - For candidate allow rules, `clearance_adversarial_cases` to stress-test the
     proposal with adversarial near-miss cases.
   - `clearance_validate_pack` to collect ordered validation slots, filling any
     missing replay or adversarial evidence in the in-memory cache.
6. Present the shared batch through `clearance_present`. It fills evidence,
   renders the summary-first card, and collects approve-all or per-family
   accept / reject / skip decisions. On explicit approval only, it validates
   and writes approved user-owned config through the existing writer seams. Do
   not write config or policy files directly as a substitute for presentation.
7. `/clearance tune` again when the Tune pass is complete.

## Approval and write boundary

`clearance_present` is the only approval and write path. On explicit approval, it
writes only user-owned config:

- global config: `global.json` under Pi Clearance's user config root;
- per-project overlay: `projects/<project-key>/overlay.json` under that same
  root.

It never writes shipped packs, repository policy, executable rule modules, or
package source code. Shipped-pack and `core-matcher` proposals route to markdown
design-input artifacts instead of writing code or config. Write-time validation
rebuilds and schema-validates the
target JSON and re-runs the effective-policy composer so sealed-floor overlap is
caught at write time; a rejected write leaves no target file or backup behind.

Project-targeted writes may still wait for Pi's project-trust signal before
project-local policy or prompt appends take effect. Tune mode does not create a
local trust record.

## Safety reminders

- Show before approve. Approval happens through `clearance_present` in Pi UI,
  not by writing files directly. With no corpus, only the human may choose the
  separately labeled approve-without-replay-evidence action.
- Size the batch to the evidence and safety profile; mode suggestions are allowed, but initial runs can be larger
  than later runs, but every change must still be shown and approved.
- Treat allow expansions as asymmetric risk: a command observed as safe once is
  not proof it is always safe. Replay and adversarial cases exist to surface
  near-miss regressions before approval.
- If validation reports a hard regression, stop and report it; do not keep tuning
  wider policy on top of it.

## Debugging fallback (not the approval path)

The shipped product workflow is Tune mode plus the `clearance_*` tools.
Maintainers may exercise the internal `runRatchetCli()` harness in
`src/skill/clearance-tune/cli.ts` (or the optional
`scripts/dev/pi-clearance-tune.cjs` wrapper) for focused replay, presentation,
write-plan, and verification debugging. That harness is not installed as a
package executable, structured proposal objects remain the source of truth, and
its `apply` seam is internal-only — it is not the user approval path and must not
be presented as such.
