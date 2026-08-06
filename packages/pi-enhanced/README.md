# @nklisch/pi-enhanced

Pi, enhanced — nklisch's full harness in one install. Policy-gated command
review, a plugin marketplace with Claude Code/Codex compatibility, ordered
subagent lifecycles, background tasks, web/repo research, fast indexed
search, model-aware prompting, and a curated daily-driver UX set.

```sh
pi install npm:@nklisch/pi-enhanced
```

That's the whole setup. The Pi packages below arrive bundled, and npm installs
the matching Pi Clearance native engine automatically. There are no separate
install commands or versions to coordinate.

## What's inside

### First-party (`@nklisch/*`)

| Package | What you get |
| --- | --- |
| pi-clearance | Structural command policy: deterministic allow/deny, one review path for uncertainty (`/clearance`). |
| pi-plugins | Plugin marketplace and lifecycle management, adopting Claude Code and Codex plugins natively. |
| pi-subagents | Subagents with ordered lifecycle interception (bundled inside pi-plugins). |
| pi-background-tasks | Background jobs with polling, status, cancellation, and wakeups. |
| pi-model-modes | System-prompt adaptation per model and mode. |
| pi-conveniences | `/exit`, `.agents/AGENTS.md` context loading, context-window footer, subagent model listing. |
| pi-fff-compat | FFF-indexed file search through Pi-native find/grep semantics (no fuzzy fallback). |

(`@nklisch/pi-zai-research` remains published separately if you prefer its
Z.ai-backed research tools over pi-web-access.)

### Curated third-party

| Package | What you get |
| --- | --- |
| pi-catppuccin-tui | Catppuccin theme + TUI polish. |
| pi-tool-display | Richer tool-call rendering. |
| @narumitw/pi-usage | Usage/cost tracking. |
| @juicesharp/rpiv-todo | Todo tracking. |
| @juicesharp/rpiv-ask-user-question | Structured agent questions. |
| @ff-labs/pi-fff | Fuzzy file discovery (ffind/ffgrep) — complements pi-fff-compat. |
| pi-web-access | Web search and page fetching. |

## What it doesn't set up

Packages can't carry your personal settings: theme selection, default model
and provider, API keys (`/login`), and editor keybindings remain yours. Set
`"theme": "catppuccin-tui-mocha"` in `~/.pi/agent/settings.json` for the full
effect.

## Updating

```sh
pi update --extension npm:@nklisch/pi-enhanced
```

One command refreshes the whole bundle; pin to a version with
`npm:@nklisch/pi-enhanced@<version>` if you want stability over freshness.
