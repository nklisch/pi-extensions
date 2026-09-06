---
id: subagents-ephemeral-extension-inheritance
tags: []
created: 2026-09-06
updated: 2026-09-06
---

# Revisit parent CLI-only extension inheritance when a consumer needs it

## Supplied limitation

The superseded ADR 0001 distinguished settings-discoverable extensions from
extensions supplied only through a parent's `pi -e <path>` invocation. It deferred
forwarding the parent's additional resource-loader paths because no in-scope
consumer required it and the path list was not available through the public
context boundary.

A focused inspection during foundation reconciliation found that
`packages/pi-subagents/src/lifecycle/create-subagent-session.ts` constructs a fresh
resource loader with cwd, agent directory, and prompt overrides; its
`ResourceLoaderOptions` surface does not carry additional extension paths. This
keeps the historical concern relevant as a candidate, but does not prove an
end-to-end failure on the current Pi host.

## Revisit condition

A concrete consumer needs CLI-only parent extensions to reach a child. Reproduce
that case against the supported host first and distinguish it from normal
settings discovery and model-runtime inheritance. Prefer an existing public host
resource-inheritance API if one is available; do not parse parent CLI arguments or
add a generic loader framework speculatively.

No implementation, readiness, priority, or new inheritance guarantee is approved.
The original rationale and upstream PR discussion remain recoverable from Git
history for `packages/pi-subagents/docs/decisions/0001-deferred-patches.md`.
