# User guide

Pi Clearance evaluates tool calls deterministically, then dispatches only the `review` bucket according to one global mode.

## First run

```text
/clearance setup
```

Setup presents one selector:

- **Off** — nothing is asked or reviewed; catastrophic commands and your deny rules still block.
- **Ask** — known-safe commands run automatically; everything else asks you. No model is called.
- **Auto** — known-safe commands run automatically; a model reviews the rest before asking you.

Selecting Auto shows the model/provider, prompt posture, context, and untrusted-context disclosure in the confirmation card before writing `mode: "auto"` to `global.json`.

Global and project config written through Clearance is persisted sparsely. Package installation does not read, create, repair, or rewrite user config.

## Commands

```text
/clearance
/clearance setup
/clearance mode [off|ask|auto]
/clearance settings
/clearance status
/clearance packs
/clearance scope
/clearance tune
/clearance why
/clearance allow <plain language>
/clearance allow
```

Bare `/clearance` opens guided setup. `/clearance mode` without an argument still opens settings. `/clearance profile` and `/clearance auto` are unsupported and have no aliases. Settings mutations require interactive confirmation and write only user-owned config.

## Allow a command family

Use `/clearance allow <plain language>` to ask the agent to translate a request into a narrow structural rule. For example:

```text
/clearance allow pnpm test and any node test runner
/clearance allow read project files with rg
```

The agent authors one or more focused proposal drafts and presents them through the same confirmation card as Tune. Nothing is written until you approve the card. `/clearance allow` with no text uses bounded scan-back to find the latest blocked or asked command and surfaces its structural summary, so the agent can author a family rule or narrow it with guards. If no recent command is available, the agent asks what you would like to allow. A sealed-floor command is refused and cannot be widened; use `/clearance why` to inspect the decision.

In `off` mode, the command can still write an approved rule for a later mode change, but the agent prepends this note to the proposal summary: “Mode is `off`: nothing is asked or reviewed, so this rule changes nothing until the mode is `ask` or `auto`.”

## Runtime behavior

The sealed floor and deterministic deny rules always win. In Off mode, a review result is passed through with an audit entry whose `decisionSource` is `mode-off-passthrough`; Off does not disable explicit deny rules. Ask uses the human path and blocks unattended calls. Auto uses model review first, then human review and block-and-log fallback.

Review surfaces speak plain language. The human approval card shows what the command does, where it acts, and why you are being asked — never raw JSON (the parsed shape and tool input stay behind `/clearance why`). A denied call surfaces exactly once, inline with the tool call, with a next action (`/clearance why`; `/clearance allow` for reviewer-sourced denies). An allowed call rides the inline review note, which you can quiet or hide in the Stream briefing settings.

## Settings

The settings control center uses compact selector/toggle rows. It exposes mode, reviewer model and evidence posture, scope preset and unknown-path behavior, a pack explorer, exact gated non-Bash tools, and Stream briefing preferences (note mode, model label, accent). Every mutation uses confirmation, the config planner, atomic write, reload, and policy invalidation. Advanced context, budget, escalation, prompt appends, and overrides remain config-file settings; status names their customization categories without dumping values.

The baseline is broad by default: the [built-in packs](RULE_PACKS.md#baseline) cover inspection, shell-builtin and system/service reads, bounded development verification, network reads, typed network research, non-secret home and agent-support typed Pi reads, and safe-home typed Pi mutations. Literal project/temp output redirects and `/dev/null` are eligible, while dynamic, `.git`, unknown-fd, and network output redirects remain review-gated. Installed package packs are merely available until explicitly enabled by user-owned config.

## Safety model

- Parsed structure, not raw shell text, drives policy.
- Non-Bash tools bypass Clearance unless their exact name appears in global `gatedTools` (default `[]`); Bash is always gated and cannot be listed.
- Opted-in unknown tools follow `unknownToolPosture` (default `allow`). Wildcards and future-tool opt-in are not supported.
- Parser uncertainty and unsupported forms fail closed to review.
- Model decisions resolve one call and never create permanent policy.
- Tune mode proposes user-approved inspectable data-pack changes after replay and adversarial evidence; executable TypeScript rule modules are not supported.

See [CONFIGURATION.md](CONFIGURATION.md), [RULE_PACKS.md](RULE_PACKS.md), [REVIEWER_PROMPTS.md](REVIEWER_PROMPTS.md), and [TUNE.md](TUNE.md).
