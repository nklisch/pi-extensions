---
id: backlog-plugin-host-agent-guidance
kind: story
status: active
tags: [ux, docs, agents]
parent: null
blocked_by: []
related_to: [epic-plugin-lifecycle-simplification]
research_refs: []
mock_refs: []
created: 2026-08-22
updated: 2026-08-22
---

# Give agents a short orientation to the installed plugin set

> Workbench version mismatch: stop and offer setup upgrade.

## Problem

Agents in pi sessions know nothing about the plugin system: not that
pi-plugins exists, not which plugins are installed, what version each is,
which marketplace it came from, or what components (skills, MCP servers,
hooks) each provides. Practical consequence: an agent cannot know facts it
plainly needs — e.g. that workbench requires a version stamp in repo items,
or that an MCP tool should exist because plugin X provides a server. Today
agents reverse-engineer state databases to learn any of this
(demonstrated 2026-08-22 during the krometrail/recovery diagnosis).

## Direction (from user, 2026-08-22, corrected)

Short and sweet orientation, NOT shipped documentation. Just enough to point
an agent in the right direction:

- per installed plugin: name, version, marketplace origin, and its
  components (skills with one-liners, MCP servers, hooks where relevant);
- a few lines on management: `/plugins` surface, doctor, degraded states,
  repair/rollback;
- version-locked to the installed pi-plugins, generated from live state —
  not hand-maintained prose, and not ARCHITECTURE/SPEC-style depth (most of
  that is useless to a blind agent).

## Candidate surfaces (decide at design time)

1. **Session-context injection**: the host's extension injects a compact
   "plugin environment" block at session start (the same mechanism
   workbench uses to inject its "This repository is Workbench-owned"
   context). Always present, zero discovery burden; must stay tiny.
2. **Generated brief on disk**: the host writes a short
   `plugin-host/generated/agent-brief.md` (or similar) that a built-in skill
   or injected one-liner points agents at. Cheaper on context; requires the
   agent to fetch it.
3. **Built-in skill via the host's own skill adapter** (dogfood
   `resources_discover`): version-locked to the installed package, no pi
   changes; the SKILL.md stays a short orientation with pointers, not a
   manual.

A hybrid is likely right: 2-3 injected lines (host present, N plugins,
how to ask for more) + the generated brief for detail.
