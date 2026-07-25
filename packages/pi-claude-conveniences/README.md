# @nklisch/pi-claude-conveniences

Small drop-in conveniences that give Pi muscle-memory parity with Claude Code,
Codex, and common shells. Each convenience is a tiny, dependency-free extension
in `extensions/`; install the package once and they all load.

```sh
pi install npm:@nklisch/pi-claude-conveniences
```

## Conveniences

| Surface | What it does |
| --- | --- |
| `/exit` | Gracefully shuts Pi down — alias for the built-in `/quit`, for shell and Claude Code muscle memory. Runs `session_shutdown` handlers before exiting. |
| `.agents/AGENTS.md` context | Loads `<cwd>/.agents/AGENTS.md` as a project context file. Pi natively walks ancestors and cwd for `AGENTS.md`, but does not look inside a `.agents/` tree — this closes that gap for projects that keep agent assets under `.agents/`. |

Formerly published as `@nklisch/pi-nates-toolkit` (extension surfaces only;
the toolkit's standalone skills remain available through the skills
marketplace).
