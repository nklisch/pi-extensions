# Vision

## The problem

Pi ships a single fixed system prompt: a neutral "expert coding assistant"
voice with no awareness of which model is answering. Two gaps result.

1. **No model identity.** The model never learns what it is. GLM-4.6, Claude
   Sonnet, and GPT-4o all receive the identical line — *"You are an expert
   coding assistant operating inside pi"* — with no name, no provider, no
   frame to ground its behavior. Switching models mid-session changes nothing
   in the prompt.

2. **No behavioral range.** Pi's voice is one neutral default. There is no
   way to ask for more autonomy, a higher quality bar, a narrower scope, or a
   different tone. Every project and every task gets the same disposition.

## What this is

**pi-model-modes** is a pi extension that gives the agent a live identity
and a selectable working mode, composed into the system prompt every turn.

- **Identity injection.** Each turn the agent is told what model it is, read
  live from the active model. The line stays correct through `/model`
  switches because it is derived per turn, never cached against a stale
  snapshot.
- **Composable modes.** A mode is one **base** voice + one value from each
  of three orthogonal axes (**agency** × **quality** × **scope**) + zero or
  more **modifiers**. Presets bundle common combinations into a single name.
- **Orthogonal writing styles.** One optional style controls user-facing prose
  across every mode, separating communication posture from task posture.
- **Transform, not replace.** Modes modify pi's assembled system prompt
  rather than discarding it — tools, skills, and `<project_context>` survive
  for free.

## Who this is for

Developers who want their coding agent to match the work: assertive on
greenfield builds, surgical on legacy edits, readonly on review, calm on
long sessions. Anyone who has watched a model hedge when they wanted
conviction, or refactor when they wanted a one-line fix.

## What success looks like

- The model knows what it is — by name and provider — on every turn.
- Switching a mode measurably changes the agent's disposition within one turn.
- Switching models updates the identity line on the next turn.
- The assembled system prompt is byte-identical across turns where nothing
  relevant changed, keeping provider prefix caches warm.
- With no mode selected, pi behaves identically to baseline — zero
  side-effects on tools, skills, context, or caching.

## What this is not

- Not a launcher or wrapper binary — it is a pure in-process extension.
- Not a full base-prompt *replacement* system. Bases are voice overlays
  spliced into pi's prompt, not wholesale skeleton replacements.
- Not project-auto-detecting — mode selection is always an explicit user
  action (command, keybinding, or their own config).
