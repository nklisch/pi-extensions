---
id: feature-fix-clearance-postinstall-runtime
kind: feature
status: completed
tags: [bug, publishing]
created: 2026-08-06
completed: 2026-08-06
---

Published `@nklisch/pi-clearance@0.2.1` without npm install lifecycle hooks. Pi now receives the same source-based package shape as the repository's other extensions; package installation does not read or write Clearance config. Removed the dead repair implementation/tests, retained sparse confirmed runtime writers, and reconciled package foundations. Evidence: `npm run check`, packed and registry-install probes on Node 24, clean independent review, commit `bf644bf`, and successful trusted-publishing run `31080104052`.
