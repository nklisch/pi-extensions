---
id: epic-plugin-lifecycle-simplification
kind: epic
status: completed
parent: null
created: 2026-08-22
completed: 2026-08-22
---

# Replace the transactional plugin lifecycle with files-and-pointer convergence (completed)

Delivered. pi-plugins lifecycle mutations are single CAS sqlite transactions
over immutable revision dirs; startup converges (migration once, then
reconstruction + bounded sweep) instead of recovering; broken revisions are
degraded-and-visible with session-local fallback and explicit repair/rollback.
"Recovery" is no longer a user-facing concept, and no session can block
another session's lifecycle operations — the only remaining cross-process
coupling is the millisecond sqlite write window (fail-not-block, typed BUSY),
pinned by e2e.

Both features completed; full design and both review adjudications were
recorded in the active item (superseded by this stub). Root `npm run check`
green throughout; migration verified against a real wedged state snapshot;
ARCHITECTURE.md/SPEC.md/CHANGELOG reconciled. Branch
`pi-plugins/lifecycle-convergence`, U1–U5 plus two review-fix passes.

Follow-ups parked in `.work/backlog/`: plugin-host agent guidance, MCP
candidate-attach surfacing (remainder of
`backlog-mcp-programmatic-peer-resolution`), fs-capability magic-number gate
removal, trust-continuity grant fold-in, broker ticket expiry.
