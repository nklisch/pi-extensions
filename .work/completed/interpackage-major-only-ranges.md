---
id: interpackage-major-only-ranges
kind: story
status: completed
tags: [fix, packaging]
created: 2026-08-02
completed: 2026-08-02
---

pi-enhanced's `@nklisch/*` dependency ranges were caret-with-patch-floor
(`^0.1.18`), which on 0.x packages locks to the 0.MINOR line — the bundle
shipped registry pi-plugins@0.1.23 (plus pi-mcp-adapter@2.11.0-nklisch.6)
while the repo carried 0.2.5. All six ranges are now major-only (`^0`);
pi-enhanced resolves every nklisch package to the workspace version with no
nested registry copies. Policy recorded in `.work/CONVENTIONS.md`:
major-only inter-package ranges, never exact or patch-floor pins, with the
pi-plugins sibling pins (pi-mcp-adapter, pi-subagents) documented as the
deliberate exact-pin exception under the released-together provenance
contract. Evidence: `npm ls` shows workspace resolution; stale lockfile
entries pruned; `npm run check` green including pi-enhanced bundle
verification.
