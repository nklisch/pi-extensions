---
id: staged-plugin-updates
---

# Staged plugin updates (completed 2026-08-02)

Updates now stage in the background and activate on next start. Lifecycle
gained a `staged` result (commit without activation); startup reconstructs the
runtime (including committed pending candidates) before the recovery sweep so
staged transitions finalize instead of rolling back; the reload-authority gate
(`awaiting-host-context`) is gone. "Update all" is sync-now: refresh + stage
all eligible + one plain per-plugin summary + one optional reload offer.
Run outcomes carry plugin/display/reason with plain-language lines; successor
screens and command-id leaks removed; staged-vs-stuck rows discriminate via
the recovery sweep. `--explicit` parser drop fixed. Design review (GLM-5.2)
and implementation review (GLM-5.2) both adjudicated; the review's blocker
(desired-state excluded pending records) was fixed in
`runtime-desired-state.ts`. `npm run check` green. Full design and evidence:
git history for this stub's predecessor in `.work/active/`.
