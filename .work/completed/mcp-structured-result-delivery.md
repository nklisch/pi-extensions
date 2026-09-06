---
id: mcp-structured-result-delivery
kind: feature
status: completed
owner: workbench
created: 2026-09-05
completed: 2026-09-05
---

# Preserve structured MCP results in model-visible delivery

Delivered shared success/error presentation of distinct structured facts alongside native content, recoverable bounded output including adapter-added guidance, depth-tolerant exact JSON deduplication, and call-local canonical results for scripts. Large line counts cannot turn successful dispatch into `call_failed`; comparison faults do not silently suppress facts.

Independent Astra review accepted the final correction delta over `89bfa5a`. Parent reproduced all three final regressions before fixing them, then passed typecheck, 114 focused tests, the full root `npm run check` (including 1,043 adapter tests), packed-package qualification, and diff checks using status-preserving commands. Earlier design, implementation and review history is retained in `e63a5e7` and `89bfa5a` at `.work/active/mcp-structured-result-delivery.md`.

Evidence includes generic message delivery and offline Anthropic request construction through Pi AI 0.82.0, aborting inside `onPayload` before dispatch. Installed Pi 0.85.1, native Claude/Codex hosts, a live Rust-server journey, and live providers remain unqualified here. No version bump, publication, installation update, or production configuration change was performed.
