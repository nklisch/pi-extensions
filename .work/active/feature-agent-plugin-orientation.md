---
id: feature-agent-plugin-orientation
kind: feature
status: active
tags: [ux, agents]
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
created: 2026-08-22
updated: 2026-08-22
---

# Agent orientation to the installed plugin set

> Workbench version mismatch: stop and offer setup upgrade.

## Outcome

Agents in pi sessions get a short, generated orientation to the plugin
system: which plugins are installed, each one's version and marketplace
origin, and what components each provides (skills with one-line
descriptions, MCP servers, hooks where relevant) — plus degraded/backup
status. An agent can then answer "what plugins do I have", know that a
plugin requires a version stamp (e.g. workbench), and know that an MCP tool
or skill should exist because plugin X provides it.

## Settled requirements (user, 2026-08-22)

- **Short and sweet**: orientation, not documentation. Generated from live
  state, version-locked to the installed pi-plugins; no hand-maintained
  prose, no ARCHITECTURE/SPEC depth.
- **Two surfaces**: (a) 2-3 lines injected as session context at session
  start carrying AGENT-relevant facts only — installed set, versions,
  marketplaces, component availability, degraded status; (b) a generated
  brief file with the per-plugin detail.
- **No user-facing commands in the injected line** (no "Manage: /plugins
  …"). The brief file MAY include a user-facing command section (/plugins
  list, doctor, updates, repair, rollback) but must mark it explicitly as
  user-facing explanation so the agent relays it to help the user rather
  than treating the commands as agent tools.

## Boundary

In scope: session-start injection via the host's extension, brief generation
from live host state, refresh after lifecycle mutations, tests. Out of
scope: changes to pi itself, plugin-authored skill content, deep reference
docs.

## Closure evidence

- A fresh pi session's agent context contains the injected orientation with
  correct plugin/version/marketplace facts and no user-facing commands.
- The brief file exists, is current after an install/update/disable, marks
  the user-facing section, and stays within a small size budget.
