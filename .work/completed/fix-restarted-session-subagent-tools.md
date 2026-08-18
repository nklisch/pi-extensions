---
id: fix-restarted-session-subagent-tools
kind: feature
status: completed
tags: [subagents, runtime, regression]
created: 2026-08-18
completed: 2026-08-18
---

The pi-enhanced subagent wrapper now bridges the public `@earendil-works/pi-ai/compat` peer subpath into its nested Jiti loader, so externally installed Pi hosts register `subagent`, `get_subagent_result`, and `steer_subagent` instead of silently dropping the extension. A packed-harness regression verifies all three tools before and after `SIGKILL` plus same-session process replacement. Foundation docs now match the manifest-shape load gate and current sibling version. Evidence: `npm run check`, the restart regression, Workbench validation, and knowledge-index validation all pass; the user explicitly waived independent review.
