---
id: subagents-host-session-sync-opportunity
tags: []
created: 2026-09-06
updated: 2026-09-06
---

# Revisit child-session integration if Pi supplies session synchronization

## Supplied opportunity

The former `packages/pi-subagents/docs/architecture/client-server-opportunities.md`
considered Mario Zechner's [session-sync plan](https://jot.mariozechner.at/s/zgzbq9n4f4mfck).
It assumed a host-owned multi-session server, client watch/join operations, and
canonical snapshots plus deltas. Those assumptions are not verified current SDK
capabilities or a commitment to implement them here.

If Pi supplies that boundary, three operator needs might become ordinary host
operations: view live child sessions, reopen suspended child sessions, and join a
child interactively with an editor. Host-managed subscriptions and rehydration
could replace parts of this package's activity observation, widget refresh,
live/file transcript sourcing, and steering glue rather than adding another
parallel system.

The subagent-specific layer would still need agent identity, concurrency admission,
result delivery, workspace context, and prevention of recursive orchestration.

## Prerequisites and unresolved questions

- Establish the actual public host API and its multi-session model/authentication
  ownership before designing against it; avoid process-global provider collisions.
- Preserve workspace cwd and child identity across snapshots and rehydration.
- Keep parent-only orchestration tools out of children, including operator-joined
  children; use the code-owned tool set rather than a fixed historical count.
- Decide whether operator-submitted commands require a different authorization
  posture from parent-submitted commands.
- Establish how parent continuity, retained results, and runtime cleanup compose
  with host-managed session lifetime.

No client/server framework, editor, new API, or implementation is commissioned.
Prefer adopting proven host machinery over duplicating it. Current read-only
navigation and lifecycle contracts remain authoritative until deliberately changed.
