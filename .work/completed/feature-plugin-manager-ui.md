---
id: feature-plugin-manager-ui
kind: feature
status: completed
owner: workbench
created: 2026-08-26
completed: 2026-08-27
mock_refs:
  - .mockups/flows/plugin-manager-ui/index.html
---

# Add a stable multi-select plugin manager (completed)

Delivered the keyboard-first `/plugins` manager over filesystem truth, including Installed, Discover, Marketplaces, and Issues views; local search and component details; explicit sequential batches; cancellable bounded marketplace checks; marker-authorized startup updates; and `/plugins update-marked`. Runtime mutations reload Pi once when the manager closes, while progress, selections, results, and errors remain transient.

`@nklisch/pi-plugins` is prepared as 0.6.0 and `@nklisch/pi-enhanced` as 0.2.5. Focused verification passed 26 tests plus typecheck, build, and package imports; the repository `npm run check` gate passed. A Kimi K3 implementation review found no blockers, and its three material findings were corrected before closure.
