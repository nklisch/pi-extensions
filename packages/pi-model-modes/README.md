# pi-model-modes

A [pi](https://pi.dev) extension that adapts the system prompt per model and per
behavioral **mode**.

Every turn it tells the model what it is — `You are {model.name} from {provider}.`
— read live from `ctx.model`, and (when a mode is selected) splices a composable
mode into pi's assembled system prompt. It **transforms** pi's prompt rather than
replacing it: tools, skills, `<project_context>`, and date/cwd all survive. With
no mode selected, only the identity line is added.

The assembled prompt is byte-stable across turns where nothing relevant changed
(a per-turn cache key over model + mode signature + pi's base keeps provider
prefix caches warm).

## Install

This is a pi package (`pi-package` keyword + `pi` manifest in `package.json`,
entry at `extensions/index.ts`).

```bash
pi install npm:@nklisch/pi-model-modes

# From this monorepo — edits hot-reload via /reload during development
pi install /absolute/path/to/pi-extensions/packages/pi-model-modes

# Or try it for the current run only, without writing to settings
pi -e /absolute/path/to/pi-extensions/packages/pi-model-modes
```

`pi install` writes the package into your `settings.json` `packages` list; the
extension is then auto-loaded on every session.

## Using modes

A **mode** composes one **base** voice + one value from each of three axes
(**agency** × **quality** × **scope**) + zero or more **modifiers**. A **preset**
is a named bundle of those choices, applied atomically.

### Commands

| Command | Effect |
|---|---|
| `/mode` | Show the effective mode (its source tier + composed axes) and the available presets. Display-only — triggers no turn. |
| `/mode <preset>` | Set the mode for this session (an ephemeral override). Unknown presets surface an error and leave the prior mode intact. |
| `/mode none` | Set a virtual no-mode override for this session. It injects no mode fragments and still wins over the config default. |
| `/mode off` | Clear the session override; falls back to the config default (or unset). |
| `/mode default` | Show the durable default configured in global + project config files, and which scope wins. Display-only — triggers no turn. |
| `/mode default <preset>` | Set the **project** default mode in `<cwd>/.pi/pi-model-modes.json`. Use `none` to make "no mode" the durable project default. |
| `/mode default <preset> --global` | Set the **global** default mode in `~/.pi/agent/pi-model-modes.json`. `--global` may appear before or after the preset. |
| `/mode default off [--global]` | Clear the default in project scope (or global scope with `--global`); after clearing project scope, any global default becomes effective again. |

`/mode:inspect` shows the effective mode, the derived identity line, when/why the
prompt last changed, and the current cache key — useful for debugging cache
behavior or a stuck mode. Add `--prompt` to append the full assembled system
prompt in a fenced block. The prompt view uses the most recent pi base prompt
seen by the turn handler; if no turn has run yet it reports that the base prompt
has not been populated rather than guessing.

### Footer indicator

The effective mode is shown in pi's footer as `mode: <glyph> <summary>` under
this package's own `pi-model-modes` status key. The glyph is `◆` for pi/default
voice, `◇` for `chill`, `⬡` for `flow`, and `✕` when the current mode is
unresolvable. The text then shows the preset/voice summary plus `+N` when
modifiers are active; an unset state renders like `mode: ◆ unset`. In TUI mode
the label, glyph, value, and hint use pi's active theme tokens, so Catppuccin
flavors inherit their own colors cleanly.

When keyboard cycling is enabled, the footer also adds the cycle hint:
`ctrl+shift+u/ctrl+shift+alt+u cycle`.

### Keybindings

No mode-cycle shortcut is registered by default. Mode changes are made with
`/mode`; this avoids terminal control-character collisions such as `Ctrl+M`,
which is encoded like Enter in legacy terminal input.

To opt into keyboard cycling, set `cycleKeybinding: true` in the **global**
config file (`~/.pi/agent/pi-model-modes.json`). This registers
`Ctrl+Shift+U` to cycle forward and `Ctrl+Shift+Alt+U` to cycle backward through
the preset list, and enables the footer cycle hint.

### Config default

A durable default mode can be set either with `/mode default …` or by editing a
plugin-owned config file directly (separate from pi's closed `settings.json`,
which has no plugin namespace). Two files are read **project over global**;
scalar keys shallow-merge, while `customStyles` merges per name:

- global:  `~/.pi/agent/pi-model-modes.json`
- project: `<cwd>/.pi/pi-model-modes.json`

Shape (v1):

```json
{ "defaultMode": "flow" }
```

The command surface mirrors that merge model:

```text
/mode default flow          # write project default
/mode default --global flow # write global default
/mode default none          # project-level durable no-mode, masking any global default
/mode default off           # clear project default; global may become effective
/mode default off --global  # clear global default
```

Autocomplete surfaces `--global` as the first choice after `/mode default ` and
continues with preset completion after `/mode default --global `. The bare `/mode`
panel also prints both durable forms so persistence is discoverable without reading
documentation.

Writes preserve sibling keys such as `cycleKeybinding`, format JSON with two-space
indentation, and refuse to overwrite malformed/non-object JSON files. An invalid
`defaultMode` (unknown preset / missing fragment) warns and is skipped during
session start; command-time writes validate before touching disk.

### Writing styles

An optional writing style controls conversational communication independently
of the active mode. Bundled styles are `clear`, `compact`, `explanatory`,
`expressive`, and `straight`. `straight` leads with direct technical judgment,
removes sugarcoating and false balance, and keeps explanations self-contained.

| Command | Effect |
|---|---|
| `/style` | Show the effective selection, selection tier, fragment provenance, and style catalog. Display-only — triggers no turn. |
| `/style <name>` | Set a temporary session override. |
| `/style none` | Explicitly suppress style injection for this session, masking any configured default. |
| `/style off` | Clear the session override and reveal the project/global default or unset state. |
| `/style default` | Show global, project, and effective durable style defaults. Display-only — triggers no turn. |
| `/style default <name|none>` | Set the project default; `none` durably masks a global style. |
| `/style default <name|none> --global` | Set the global default; `--global` may appear before or after the value. |
| `/style default off [--global]` | Delete `writingStyle` from the selected scope; clearing project scope may reveal the global default. |

For example:

```text
/style expressive                 # temporary experiment
/style default clear              # persistent project default
/style default --global compact   # persistent global default
/style none                       # temporarily mask either default
/style off                        # reveal the configured default
/style default off                # clear project default; reveal global
/mode straight                       # direct premise-checking behavior
/style straight                      # direct, self-contained prose
```

The `straight` mode and style are independent. Use either one alone, or select
both when you want the behavioral base and the writing posture together.

The same durable selection can be edited directly in config:

```json
{
  "defaultMode": "flow",
  "writingStyle": "team-voice",
  "customStyles": {
    "team-voice": "styles/team-voice.md"
  }
}
```

Custom paths must be relative `.md` files contained within the defining config
directory; absolute paths, escapes, and escaping symlinks are rejected. Global
and project maps merge per key, with project entries winning. Custom style
names cannot be `none`, `off`, or `default` because those tokens belong to the
command grammar.

Styles inject even when no mode is active, after identity and before mode
fragments. They affect only conversational communication with the user. They do
not control code or code comments, authored project documentation, tool use,
autonomy, edit scope, or problem-solving/implementation strategy.
`/mode:inspect` reports selection provenance separately from bundled/custom
fragment provenance.

**Mode precedence:** session override (`/mode`) > config default > unset.
The override is ephemeral (in-memory, not written to disk): a genuinely new
session (`/new`, `/resume`, `/fork`) restarts from the config default, while a
same-session `/reload` or `startup` keeps any active override. Changing the
default does **not** clear an active override; run `/mode off` to let the default
take effect immediately.

## Mode reference

**Base** voice (default `pi` = no overlay, identity only):

- `pi` — no voice overlay
- `chill`, `flow`, `pi-direct`, `straight` — overlay voices (`prompts/base/*.md`)

**Agency** — `autonomous` · `collaborative` · `surgical` · `partner`

**Quality** — `architect` · `pragmatic` · `minimal`

**Scope** — `unrestricted` · `adjacent` · `narrow`

**Modifiers** (zero or more) — `bold` · `tdd` · `debug` · `flow` · `muse` ·
`readonly` · `methodical` · `director` · `speak-plain` · `context-pacing` ·
`playful`

### Built-in presets

| Preset | base | agency | quality | scope | modifiers |
|---|---|---|---|---|---|
| `create` | pi | autonomous | architect | unrestricted | — |
| `extend` | pi | autonomous | pragmatic | adjacent | — |
| `safe` | pi | collaborative | minimal | narrow | — |
| `refactor` | pi | autonomous | pragmatic | unrestricted | — |
| `explore` | pi | collaborative | architect | narrow | readonly |
| `debug` | chill | collaborative | pragmatic | narrow | debug |
| `methodical` | chill | surgical | architect | narrow | methodical |
| `director` | chill | collaborative | architect | unrestricted | director |
| `partner` | chill | partner | pragmatic | adjacent | speak-plain, tdd |
| `muse` | chill | autonomous | architect | unrestricted | muse |
| `flow` | flow | autonomous | architect | adjacent | flow |
| `tinker` | flow | autonomous | pragmatic | unrestricted | flow, playful |
| `spark` | chill | autonomous | architect | unrestricted | muse, playful |
| `straight` | straight | autonomous | pragmatic | adjacent | — |
| `none` | — | — | — | — | virtual no-mode override |

Preset definitions live in [`presets.json`](presets.json), except `none`, which
is virtual and injects no mode fragments. The fragment text lives in
[`prompts/`](prompts) (`base/`, `axis/{agency,quality,scope}/`, `modifiers/`).
Fragment files are cached by mtime, so editing one takes effect on the next turn
— no `/reload` needed. The `straight` base was adapted from the intent of
`claude-code-modes`: correctness over agreement, explicit premise checking, and
direct criticism of the work without turning abrasiveness into a persona.

## How it works

- **Identity is additive.** `You are {model.name} from {provider}.` is prepended
  as the very first line on every turn — including mode-unset turns and turns
  with a custom `SYSTEM.md` / `--system-prompt`. It never overrides or removes
  the user's base content.
- **Assembly is deterministic.** Within the splice, order is fixed: identity →
  optional writing style → base voice → agency → quality → scope → modifiers
  (in preset-declared order) →
  pi's assembled base.
- **Cache-stable.** The handler computes a cache key each turn over
  `model.name` + `model.id` + `model.provider` + the mode signature + the style signature + a hash of pi's base, and
  only re-assembles on a miss. There are no timestamps, counters, or
  nondeterministic values in the assembled output, so consecutive no-change
  turns produce byte-identical prompts.
- **No-op when unset.** With no mode or style selected, only the identity line
  is prepended; the legacy bytes after it are unchanged.
- **Modes are advisory for spawned subagents.** Mode fragments splice into the
  *main session's* system prompt. When you spawn a subagent (e.g. via pi's
  `subagent` tool), the agent's own definition file (its `*.md` under
  `~/.pi/agent/agents/`) is appended *after* the mode fragments, so on any
  conflict the agent's hardcoded posture wins. Selecting `/mode surgical` will
  not, for example, override the `implementor` agent's designed refactor scope —
  modes retune the conversation you're in, not the specialists you delegate to.

The hard contract (invariants, cache key, resolution precedence) is documented in
[`docs/SPEC.md`](docs/SPEC.md); the component layout and per-turn flow are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Development

- **Runtime:** Node >= 22.19.0
- **Install:** `npm install`
- **Test:** `npm test`
- **Typecheck:** `npm run typecheck`

The registration surface is a single factory in
[`extensions/index.ts`](extensions/index.ts) — the `before_agent_start` handler,
`/mode`, `/mode:inspect`, and `/style` commands, plus `session_start` config and
TUI autocomplete handlers. All logic
lives in plain modules under `src/` with no pi coupling except through typed
interfaces, which keeps it unit-testable without spinning up pi (tests under
`tests/`).
