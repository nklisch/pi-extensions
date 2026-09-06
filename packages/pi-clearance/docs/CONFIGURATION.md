# Configuration reference

Pi Clearance uses strict JSON schemas. Missing config is safe and normalizes to `mode: "ask"`; unknown fields are rejected and invalid config causes the composer to use the sealed floor only. Config written through Clearance is sparse: persisted global and project files contain `version` plus only non-default user choices. Defaults remain runtime-only, so the examples below intentionally omit default scaffolding. Package installation never reads, creates, repairs, or rewrites user config.

## Files

- `global.json` — user-owned global mode, packs, reviewer advanced settings, and display preferences.
- `projects/<project-key>/overlay.json` — user-owned project packs, scope, and trusted prompt appends.
- Existing `projects/<project-key>/trusted.json` files are inert migration leftovers; Pi Clearance never reads or writes them.
- `.pi-clearance/policy.json` — optional repository policy; tighten-only unless Pi reports the project as trusted.

## Global config

```json
{
  "version": 1,
  "mode": "auto",
  "gatedTools": ["pi.read"],
  "packEnablement": { "enabledPackagePacks": ["example.package-pack"] },
  "reviewer": { "model": "openai/example" },
  "display": { "reviewNote": { "accent": false } }
}
```

A default global config is simply `{ "version": 1 }`. For example, setting only
`mode` persists `{ "version": 1, "mode": "auto" }`; the omitted reviewer,
display, pack, and posture fields are supplied by runtime normalization.

`mode` is global-only:

| Mode | Review bucket | Deterministic deny |
|---|---|---|
| `off` | allow and audit as `mode-off-passthrough` | still deny |
| `ask` | human prompt; unattended calls block-and-log | deny |
| `auto` | model first, then human/block fallback | deny |

`gatedTools` is a global exact-name list and defaults to empty. Non-Bash tools absent from the list bypass Clearance analysis and policy entirely, execute, and receive an audit entry marked as an allow/bypass. There are no wildcards or future-tool opt-ins, and `bash` cannot be listed. Bash remains fully gated. Typed edit/read protections are opt-in.

`unknownToolPosture` remains a config-file-only knob and applies only to an opted-in non-Bash tool that has no registered analyzer. It defaults to `"allow"`; it does not re-gate tools absent from `gatedTools`. Setting it to `"review"` or `"deny"` tightens opted-in unknown tools. The sealed floor and all active user/shipped deny rules run in every mode.

There is no `defaultPosture`, `maxPosture`, project/repository `posture`, `reviewer.enabled`, or `reviewer.mode`. Those legacy keys are not translated; strict validation rejects them and runtime falls back to floor-only policy. There is no consent file or Clearance trust record: explicit `mode: "auto"` is the acknowledgment, and existing trust files are inert.

## Project overlay

```json
{
  "version": 1,
  "projectScope": {
    "roots": ["packages"],
    "safeHomeUseDefaults": false,
    "homePathBehavior": "review"
  },
  "promptAppends": ["Prefer the project test command."]
}
```

A default project overlay is `{ "version": 1 }`. Non-default nested scope
fields are retained without persisting the other scope defaults.

`unknownPathBehavior` and `sensitivePathBehavior` are ceilings, not just knobs: even `review` emits a config-derived rule so no allow can auto-clear unknown or sensitive-home (credentials, keys, auth files) paths, and `deny` hard-blocks them. One exception: scope classification puts writable-project/project ahead of sensitive-home, so a sensitive location explicitly made a project root classifies as project and the sensitive ceiling does not fire there. `homePathBehavior: "review"` sends any command touching home paths to review. Configured `deniedDirectories` deny outright at the effective-policy level. These rules compose as the derived `config.scope.behavior` pack; they never appear in `/clearance packs` because they are a projection of config, not a discoverable pack.

Three presets bundle the behavior fields and apply via `/clearance scope preset <project|home|unrestricted>` or the settings scope panel: **project** (safe-home/agent-support defaults off, home paths review), **home** (defaults on, home reads allowed, sensitive review), **unrestricted** (defaults on, sensitive denied). Presets never touch path lists; a mixed configuration reads as "custom".

`agentSupportUseDefaults` enables the built-in Pi support roots under `$HOME/.pi/agent` (skills, plugins/extensions, docs, rules, the agent npm `node_modules`, and plugin-host stores). `agentSupportDirectories` adds explicit lexical roots; absolute paths may live outside `$HOME`, while relative entries resolve against the project cwd. These roots only affect typed read/search/list tools. Sensitive-home classification runs first, so `$HOME/.pi/agent/auth.json`, provider key stores, and the rest of the sensitive catalog remain review-gated. Disable the defaults when a project should use only explicitly configured support roots.

Mode cannot be set per project. Repository policy has `version`, `packs`, and `promptAppends`; it has no posture, mode, or local trust switch. The removed `requireTrust` key is rejected by strict schema validation.

## Reviewer advanced settings

The reviewer settings selector exposes `promptPosture` and `model` interactively; both changes use Pi confirmation and write only user-owned config. The remaining config-file-only reviewer fields are `promptAppends`, `projectPromptAppends`, `promptOverride`, `tokenBudget`, `contextMode` (default `recentContext`), `recentContext` (including `conversationTurns`, `userTurns` default `5`, and the shared `conversationCharLimit`), and `escalation`. `display.reviewNote` preferences (mode, model label, accent) are editable in the settings Stream briefing panel. The shipped prompt ids are `reviewer.strict`, `reviewer.default`, and `reviewer.permissive`.

## Packs

The built-in baseline is described in [RULE_PACKS.md](RULE_PACKS.md#baseline), including `bash.network.read`, `pi.extension.network-research`, and `pi.home.safe`. Mode never changes baseline activation. Package packs remain available until explicitly enabled through `packEnablement.enabledPackagePacks`; user-owned config packs can be disabled with `disabledConfigPacks`.

## Commands

- `/clearance` and `/clearance setup` — open guided setup; choosing Auto shows the model/context disclosure in the confirmation card.
- `/clearance mode [off|ask|auto]` — read/select or set the global mode; writes require UI confirmation. Without an argument it opens settings.
- `/clearance settings` — compact control center with selector/toggle rows, including exact gated non-Bash tools.
- `/clearance status`, `/clearance packs`, `/clearance scope`, `/clearance tune`, `/clearance why` — unchanged surfaces with mode/baseline vocabulary. Scope management also supports `scope agent-support add|remove <path>` and `scope agent-support-defaults <on|off>`.
- `/clearance allow <plain language>` or `/clearance allow` — hand an agent-authored structural allow request to the shared proposal card. Accepted rules land in the user-global pack; this command adds no separate config surface.

`/clearance profile` and `/clearance auto` are unsupported and have no aliases.
