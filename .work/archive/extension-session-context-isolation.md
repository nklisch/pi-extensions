---
id: extension-session-context-isolation
kind: feature
status: completed
owner: workbench
created: 2026-09-04
completed: 2026-09-04
---

# Keep extension work attached to its current session

`pi-conveniences` loads extra project instructions from Pi's actual workspace
context. `pi-legible` discards late rewrites after cancellation, replacement,
shutdown, or configuration reload instead of leaking messages or originals.

Regression tests cover workspace switches, deterministic cwd fallback, obsolete
rewrite completion, and successful rewrites with stale cosmetic cleanup. The
full `npm run check` gate passed; one standard inline review covered this and
the plugin-manager changes. Documentation and unreleased changelogs are updated.
No settings migration or publication was performed.
