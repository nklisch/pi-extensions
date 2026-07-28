---
id: pi-plugins-observation-refresh-ux
kind: story
status: active
tags: [fix, ux, pi-plugins]
created: 2026-07-28
updated: 2026-07-28
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
---

# pi-plugins: observation poisoning, refresh speed, loading animations

User-reported follow-ups after 0.2.0:

1. **Installs land in recovery-required despite succeeding** — ROOT CAUSE
   FOUND via live PTY repro + state forensics: `evidenceFor`
   (complete-plugin-reload) builds the activation-observation batch for ALL
   installed plugins; one degraded plugin (agile-workflow's trust-invalid
   hook, HOOK_AUTHORITY_REJECTED in logs) threw, failing the whole batch —
   every unrelated install/update reported recovery-required even though its
   own mutation committed. FIX: observation failures for non-explicit
   expectations are isolated; explicit (settling) expectations still fail.
2. **Marketplace refresh takes forever** — every refresh ran one
   materialize+inspect+assess per installed plugin SERIALLY, even when the
   fetched marketplace snapshot was byte-identical. FIX: skip probes when
   snapshot unchanged (revision+contentDigest+binding), and run probes with
   bounded parallelism (4) preserving deterministic order.
3. **Loading animations** — manager showed static "…" during
   operations/loads. FIX: 100ms braille spinner tick in the manager
   component, active only while work is in flight.

## Acceptance

- [x] Observation poison isolation + regression test
- [x] Unchanged-snapshot probe skip
- [x] Parallel probes with deterministic order + test
- [x] Spinner in manager (operation, page load, detail load)
- [x] npm run check green
- [ ] Cross-model review adjudicated
- [ ] Version bump + publish (0.2.2, carries the other agent's 0.2.1 env fix)
