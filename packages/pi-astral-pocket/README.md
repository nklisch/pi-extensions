# @nklisch/pi-astral-pocket

A persistent note pocket that activates only for `openai-codex/gpt-6-astra`
sessions. Astra gets a dedicated, cross-session note store with recall —
modeled on OpenAI Codex's memories system, minus the always-on cost.

## What it does

When the active model is astra (including mid-session `/model` switches), the
extension:

- **Injects pocket guidance** into the system prompt: when to consult the
  pocket, a budgeted "quick pass" lookup protocol, drift/verification policy,
  and note-taking judgment (durable facts only, never secrets).
- **Activates two tools**:
  - `pocket_note` — write a durable note (title, body, keywords). The store's
    registry and summary are updated mechanically on every write.
  - `pocket_recall` — keyword-search pocket notes and past **astra** sessions.
    Summarized by default (tool names + truncated args/results); `full: true`
    for larger excerpts.
- **Runs a bounded distiller pass** on activation: astra sessions idle past a
  threshold (default 6h, max 16 per pass, 30-day window) are distilled into
  pocket notes by a cheap configurable model, then consolidated into the
  injected summary's durable digest. There is no daemon; the pass only runs
  when astra activates. If the distiller is disabled or its model is
  unavailable, the mechanical floor (registry + recent-notes index) keeps
  working.

For any other model, the extension is inert: no tools, no injection, no
distiller.

## Commands

- `/pocket on` / `/pocket off` — enable/disable the pocket (persisted).
- `/pocket status` — show enablement, activation, note count, distiller config.

## Storage

Everything lives in `~/.pi/agent/astral-pocket/` (or
`$PI_CODING_AGENT_DIR/astral-pocket/`):

```
config.json     # enabled flag + distiller settings
SUMMARY.md      # injected into astra's prompt; pinned block + durable digest + recent notes
POCKET.md       # searchable registry, one line per note
notes/          # append-only note files (<timestamp>-<slug>.md)
distilled.json  # distiller bookkeeping
```

### Configuration

`config.json` (all optional, defaults shown):

```json
{
  "enabled": true,
  "distiller": {
    "enabled": true,
    "model": null,
    "minIdleHours": 6,
    "maxSessionsPerPass": 16,
    "maxSessionAgeDays": 30
  }
}
```

`distiller.model` is a `"provider/modelId"` override; when null the first
resolvable entry of a cheap-model preference list is used. If no model
resolves, the distiller skips with a notice.

## Privacy note

Pi session files record tool calls and results verbatim. `pocket_recall`
searches only astra sessions and summarizes by default, but full excerpts can
re-surface anything that appeared in past output. Keep the default summarized
mode unless you need exact commands or error text.

## Install

```sh
pi install npm:@nklisch/pi-astral-pocket
```
