---
id: deduplicate-blocking-subagent-completion
kind: feature
status: completed
created: 2026-08-26
completed: 2026-08-27
---
# Deduplicate blocking subagent completion delivery

`get_subagent_result({ wait: true })` now claims direct delivery before awaiting a background subagent, preventing the same terminal output from also enqueueing a completion follow-up. Regression coverage verifies the real tool path and preserves notifications after an interrupted wait.
