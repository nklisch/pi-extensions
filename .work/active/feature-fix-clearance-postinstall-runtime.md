---
id: feature-fix-clearance-postinstall-runtime
kind: feature
status: active
tags: [bug, publishing]
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
created: 2026-08-06
updated: 2026-08-06
---

# Remove Pi Clearance's npm install lifecycle

The published `@nklisch/pi-clearance` package installs through Pi's npm extension update flow in the same source-based shape as the repository's other Pi extensions: Pi loads the TypeScript entrypoint, release CI stages native artifacts, and npm installation runs no package-owned lifecycle hook or config migration.

This feature removes the install-time config repair, its dead implementation and tests, and all documentation claims that package installation may change user config. Sparse persistence remains the contract for config written through Clearance's confirmed runtime writers. Invalid config continues to fail closed to floor-only policy. The feature does not publish the package or alter any existing user-owned config.

Closure requires reproduction of the reported Node 24 failure, a packed-artifact regression proving that no npm install lifecycle is declared or shipped, focused package tests, the repository `npm run check` gate, standard-weight independent review, foundation reconciliation, and Workbench validation.
