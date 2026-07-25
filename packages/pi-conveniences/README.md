# @nklisch/pi-conveniences

Small drop-in quality-of-life conveniences for Pi. Each is a tiny extension in
`extensions/`; install the package once and they all load.

```sh
pi install npm:@nklisch/pi-conveniences
```

## Conveniences

| Surface | What it does |
| --- | --- |
| `/exit` | Gracefully shuts Pi down — alias for the built-in `/quit`, for shell and Claude Code muscle memory. Runs `session_shutdown` handlers before exiting. |
| `.agents/AGENTS.md` context | Loads `<cwd>/.agents/AGENTS.md` as a project context file. Pi natively walks ancestors and cwd for `AGENTS.md`, but does not look inside a `.agents/` tree — this closes that gap for projects that keep agent assets under `.agents/`. |
| Context-window footer | A footer widget showing live context-window usage as a bar, with a toggle command. Coordinates with pi-catppuccin-tui's packaged footer so only one footer owner is active (opt out with `PI_CONVENIENCES_DISABLE_CATPPUCCIN_FOOTER=0`). |
| `list_subagent_models` tool | Exposes Pi's configured model registry to the agent — available/scope-aware model listing with provider/model filters, so subagent spawning never guesses model identifiers. |

Grew out of `@nklisch/pi-nates-toolkit`'s extension surfaces and a set of
personal pi-config extensions.
