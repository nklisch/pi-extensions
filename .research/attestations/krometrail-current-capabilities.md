---
source_handle: krometrail-current-capabilities
fetched: 2026-08-18
source_title: nklisch/krometrail source and foundation at commit eb5b465
source_url: https://github.com/nklisch/krometrail/tree/eb5b465618fcaeb232c2038d8c6cf960ff499b99
---

The local sibling repository was inspected at commit `eb5b465618fcaeb232c2038d8c6cf960ff499b99` (latest commit 2026-08-15). Its `AGENTS.md`, documentation navigation, five foundation documents, public usage guide, root README, and browser/MCP source layout were read. This attestation distinguishes the documented current product boundary from broader computer-use systems.

Fetched documents:

- https://github.com/nklisch/krometrail/blob/eb5b465618fcaeb232c2038d8c6cf960ff499b99/README.md
- https://github.com/nklisch/krometrail/blob/eb5b465618fcaeb232c2038d8c6cf960ff499b99/docs/VISION.md
- https://github.com/nklisch/krometrail/blob/eb5b465618fcaeb232c2038d8c6cf960ff499b99/docs/SPEC.md
- https://github.com/nklisch/krometrail/blob/eb5b465618fcaeb232c2038d8c6cf960ff499b99/docs/ARCHITECTURE.md
- https://github.com/nklisch/krometrail/blob/eb5b465618fcaeb232c2038d8c6cf960ff499b99/docs/VISUAL-EVIDENCE.md
- https://github.com/nklisch/krometrail/blob/eb5b465618fcaeb232c2038d8c6cf960ff499b99/docs/EVALUATION.md
- https://github.com/nklisch/krometrail/blob/eb5b465618fcaeb232c2038d8c6cf960ff499b99/docs/guide/using-krometrail.md

## Attested details

1. **Current product boundary.** Krometrail is a local browser-control and temporal visual-evidence system for coding agents, exposed as a standard-input/output MCP server. The implemented root contract includes browser transport, control operations, continuous capture, durable recording, temporal investigation, retention, browser-event queries, and evidence resources. (`AGENTS.md`; `docs/SPEC.md`, Scope)
2. **Ordinary screenshots.** Its browser-control surface can take viewport, full-page, element, or region screenshots. State-changing browser actions produce a live post-action observation; explicit visual operations inline one bounded image by default, while routine action image transport can be requested or suppressed independently of structured detail. (`docs/SPEC.md`, Current-State Observation and Browser-Control Surface)
3. **Temporal screenshots.** Krometrail continuously records the controlled Chromium renderer and can turn an interval into before/during/after composites, storyboards, difference maps, region filmstrips, motion-history images, and exact source frames. Source frames remain authoritative behind derived artifacts. (`docs/VISION.md`, Core Experience and Visual Evidence; `docs/VISUAL-EVIDENCE.md`)
4. **Browser operation.** The MCP surface supports browser start/attach/stop/status, page lifecycle, navigation/history, structured accessibility snapshots, semantic queries, click/fill/type/key/select/hover/drag/scroll/upload/dialog actions, waits, JavaScript evaluation, responsive viewport control, and ordered batches. (`docs/SPEC.md`, Browser-Control Surface)
5. **Profiles and attachment.** Krometrail can launch an isolated reusable or temporary profile, reopen named managed profiles, or explicitly attach to a local debug-enabled Chromium endpoint. It does not modify the user's default browser profile unless the attach workflow is explicitly chosen. (`docs/SPEC.md`, Browser Lifecycle)
6. **Light orchestration.** It owns one active browser session per MCP process, discovers and tracks multiple page targets, anchors every interaction on a timeline, supports ordered action batches with per-step status, and offers range handles for follow-up evidence queries. (`docs/ARCHITECTURE.md`, Target Lifecycle and MCP Boundary; `docs/SPEC.md`, Sessions and Targets, Batching, Temporal Ranges)
7. **Diagnostics and evidence.** It records privacy-bounded console, exception, request/response lifecycle, navigation, target, visibility, and dialog events and correlates a compact selection with visual-change evidence. (`docs/SPEC.md`, Browser Events and Temporal Queries)
8. **Local and bounded storage.** Captured data remains local unless an agent reads it through MCP; retention is governed by a global disk budget, age limits, pinning, and explicit capture-gap reporting. No telemetry or upload occurs by default. (`docs/SPEC.md`, Disk Budget and Retention, Local Data and Telemetry)
9. **Not full desktop use.** The current control boundary is Chrome/Chromium-compatible renderer targets and explicitly debug-enabled Electron renderer processes. It does not control Electron's Node main process, non-Chromium engines, or arbitrary native desktop applications. (`docs/SPEC.md`, Supported Environment and Exclusions)
10. **Not a desktop agent manager.** Krometrail controls and records browser sessions; its documented responsibilities do not include multi-project coding-session supervision, Git worktrees, agent scheduling, cross-agent messaging, or a graphical diff/review shell. (`docs/VISION.md`, Product Boundaries; `docs/ARCHITECTURE.md`, System Context)
