# @nklisch/pi-astral-pocket

Astral Pocket keeps durable Markdown notes across Pi sessions. It activates only
when the current model is `openai-codex/gpt-6-astra`.

Notes normally belong to the current Git repository. Subdirectories and linked
worktrees share the same local repository identity. Explicit global notes can
carry a general preference or a conditional lesson between repositories.
Foreign repository memories are not injected into the current session.

## Notes and digest

The extension adds two tools while Astra is active:

- `pocket_note` saves a durable note. Its default scope is `project`. The caller
  may set `scope: "global"` only for an intentionally portable preference or
  observation.
- `pocket_recall` searches current-project and global notes, plus past Astra
  sessions from the current repository. `full: true` returns larger excerpts.
  `scope: "all"` deliberately includes other repositories and labels their
  results as cross-repository precedent. Recall returns at most 20 matches from
  each selected source.

Distillation means extracting durable decisions, constraints, preferences, and
pitfalls from an idle session into a source-linked note. Automatic extraction
always stays project-scoped. A digest is then rebuilt from the actual notes for
the current repository. Explicit global notes have a separate, smaller digest.
The extension never builds a new digest by recursively summarizing an old one.

Memory is historical evidence, not an instruction source. The current user
request and current repository guidance take priority. Verify remembered facts
when their relevance or freshness is uncertain.

## Commands

```text
/pocket status
/pocket on
/pocket off
/pocket distiller on
/pocket distiller off
/pocket model openai-codex/gpt-6-astra
/pocket model reset
/pocket reasoning minimal
/pocket reasoning off|minimal|low|medium|high|xhigh|max
/pocket reasoning reset
/pocket distill
/pocket rebuild
```

`/pocket status` shows the requested and resolved model, requested and effective
reasoning, whether distillation is enabled, and the last pass outcome. Pi may
map a requested reasoning level to a model-supported effort; status reports that
mapping.

`/pocket distill` retries changed or previously failed session work and stale
digests. `/pocket rebuild` also forces the current project and global digest
caches to be regenerated. Both commands require an active Astra session and an
enabled distiller.

Changing the model or reasoning setting cancels the current pass before starting
a replacement. Switching away from Astra, disabling the pocket, reloading, or
shutting down cancels the session-owned pass.

## Configuration

Configuration lives in `config.json`. All fields are optional. These are the
defaults:

```json
{
  "enabled": true,
  "distiller": {
    "enabled": true,
    "model": "openai-codex/gpt-6-astra",
    "reasoning": "minimal",
    "minIdleHours": 6,
    "maxSessionsPerPass": 16,
    "maxSessionAgeDays": 30
  }
}
```

The model must use the exact `provider/modelId` form. Astral Pocket asks Pi's
model registry for current authentication and headers on every request. It does
not silently select another provider when that model is unavailable. A malformed
configuration falls back to defaults without blocking note access.

## Storage and recovery

Files are stored under `~/.pi/agent/astral-pocket/`, or under
`$PI_CODING_AGENT_DIR/astral-pocket/` when that variable is set:

```text
config.json       settings
notes/            canonical Markdown notes
digests/          rebuildable per-project and global digest caches
POCKET.md         rebuildable note registry
SUMMARY.md        legacy-compatible derived summary surface
distilled.json    processed source revisions and digest fingerprints
```

Canonical note files remain readable if a model call fails or a derived registry
or digest lags. Changed sessions replace their one stable generated note. If a
fresh extraction returns `NONE`, that generated note is removed rather than
leaving superseded knowledge behind. Legacy notes are not rewritten: notes with
project metadata remain project-scoped, while notes with unknown scope appear
only in an explicit all-project recall.

There is no daemon or global worker. Work runs only on Astra activation or an
explicit command. Pi's file mutation queue serializes writes inside one process,
and files are atomically replaced to avoid torn output. Two simultaneous Pi
processes can still duplicate model calls or publish competing derived snapshots;
the extension does not claim cross-process locking. A later rebuild recovers the
registry and digest from canonical notes.

## Privacy

Session files can contain prompts, tool arguments, and tool results. Distillation
uses a bounded transcript that omits most tool output and instructs the model to
exclude credentials, personal data, quoted instructions, rejected proposals,
and facts already documented in the repository. A prompt cannot guarantee that
every sensitive value is removed.

Choosing a distiller model sends the bounded source material to that model's
configured provider. Astral Pocket never falls back to a different provider.
Use `pocket_recall` without `full` first; larger session excerpts can re-surface
sensitive text from past work. Use all-project recall only when you intentionally
want foreign repository precedent.

## Install

```sh
pi install npm:@nklisch/pi-enhanced
```

Astral Pocket is currently distributed as part of Pi Enhanced rather than as a
standalone npm package.
