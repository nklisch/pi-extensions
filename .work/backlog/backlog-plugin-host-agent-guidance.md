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

# Ship agent-facing guidance about the plugin system itself

> Workbench version mismatch: stop and offer setup upgrade.

## Problem

Agents in pi sessions have no official knowledge about the plugin host: not
that pi-plugins exists, not the `/plugins` command surface, doctor,
repair/rollback, the native control channel, or where state lives. Plugin-
shipped skills teach each plugin's domain; nothing teaches the plugin
*system*. Users ask agents about plugins ("why is X broken", "update my
plugins") and agents must reverse-engineer sqlite schemas to answer
(demonstrated 2026-08-22 during the krometrail/recovery diagnosis).

## Direction (from user, 2026-08-22)

Ship the guidance inside the pi-plugins package, version-locked to the code
it describes, in a location pi understands — simple agent instructions plus
reference pointers (the pattern pi uses for its own docs).

## Candidate shapes (decide at design time)

1. **Dogfood the skill adapter (preferred)**: pi-plugins owns
   `resources_discover`; emit a built-in `plugin-host` skill from the
   installed package — version-locked by construction, no pi changes needed.
2. **`pi.skills` package field**: works only for top-level packages in pi
   settings; pi-plugins is a transitive dep of pi-enhanced, so this currently
   reaches no agent (pi-mcp-adapter's shipped skill has the same problem).
   Would need pi to read skills from transitive deps, or pi-enhanced to
   re-export.

Content sketch: what the host is; the `/plugins` command surface
(list/doctor/repair/rollback/updates); how to read degraded states; where
state lives (~/.pi/agent/plugin-host/); pointers to ARCHITECTURE.md/SPEC.md
for deep questions. Keep it short — orientation, not a manual.
