# @nklisch/pi-legible

Rewrites assistant prose through a second model for legibility. The original
message streams live as usual; once it completes, a rewriter model rewrites
each text block and the clearer version swaps into the chat.

**You see the rewrite. The agent keeps the original.** Before each LLM call,
pi-legible swaps the original text back into the context the agent sees, so
the rewriter can simplify aggressively without degrading the agent's memory
of its own work. Originals are also restored into compaction input, so
summaries are generated from full-fidelity text.

Known limit: originals live in memory. After restoring a session from disk,
older messages are covered only if they were rewritten in this process —
new messages always are.

## Install

```sh
pi install npm:@nklisch/pi-legible
```

## How it works

- Hook: `message_end` replacement (pi has no mid-stream rewrite hook, so the
  swap happens after each message finishes streaming).
- The rewriter sees: your rules + a small slice of recent conversation
  (originals, never rewrites) + the message to rewrite. It does **not** see
  the full conversation.
- Rewrite failures are non-fatal: the original message is shown, with one
  warning notification per session. Each rewrite has a 30-second timeout so
  a hung rewriter cannot stall the agent loop.
- A configured rewriter model that cannot be resolved (typo, expired auth)
  fails safe — originals are shown — rather than silently billing rewrites
  to the session model.
- Latency: one extra model call per assistant text block (blocks in a
  message are rewritten concurrently). Pick a fast model — see below.

## Project trust

Project-level settings (`.pi/pi-legible.json` and `LEGIBLE.md`) shape prompts
sent to an authenticated model, so they are honored **only when the project
is trusted** in pi. In untrusted projects, only your global config and rules
apply.

## Commands

| Command | Effect |
| --- | --- |
| `/legible` | Show status (enabled, model, depth, rules source) |
| `/legible on` / `/legible off` | Enable/disable rewriting |
| `/legible model <spec>` | Set rewriter model, e.g. `openai/gpt-5.6-mini` or a bare model id |
| `/legible model default` | Reset to the session model |
| `/legible depth <n>` | How many recent messages the rewriter sees (0–20, default 6) |
| `/legible tools on` / `/legible tools off` | Include tool calls/results in the rewriter's context (default on) |
| `/legible rules` | Show which rules file is in effect |
| `/legible reload` | Reload config and rules from disk |

## Rewrite rules: `LEGIBLE.md`

The rewriter's instructions come from the first of:

1. `LEGIBLE.md` in the project root (AGENTS.md-style, project-specific rules)
2. `~/.pi/agent/LEGIBLE.md` (your global rules)
3. Built-in defaults (plain language, lead with the outcome, keep paths/code/
   errors verbatim, don't add or drop information)

Edit the file and run `/legible reload` (or restart) to apply.

## Configuration

Settings persist to `~/.pi/agent/pi-legible.json`; a project can override any
key with `<project>/.pi/pi-legible.json` (project wins):

```json
{
  "enabled": true,
  "model": "openai/gpt-5.6-mini",
  "contextDepth": 6,
  "includeToolCalls": true
}
```

Note: because a project file wins on merge, keys it sets mask later
`/legible` command writes (which go to the global file).
