---
source_handle: antigravity-2-computer-use
fetched: 2026-08-18
source_title: Google Antigravity 2.0 feature and Artifact documentation
source_url: https://www.antigravity.google/docs/features/
---

Google's current Antigravity 2.0 feature overview and Artifact documentation, plus Google's original official launch description, were fetched. This attestation records the documented product surface and does not infer unlisted capabilities.

Fetched documents:

- https://www.antigravity.google/docs/features/
- https://antigravity.google/docs/artifacts/
- https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/

## Attested details

1. **Two primary surfaces.** Google introduced Antigravity with an Editor View for direct IDE work and a Manager surface for spawning, observing, and orchestrating several asynchronous agents across workspaces. (`Build with Google Antigravity`)
2. **Cross-tool agent execution.** Agents are described as planning, executing, and verifying tasks across the editor, terminal, and browser, including starting an application and testing the result in the browser. (`Build with Google Antigravity`)
3. **Project isolation.** Antigravity 2.0 Projects support native Git worktrees for background isolation, project-scoped settings and permissions, and access to multiple folders or codebases in one conversation. (`Feature Overview`)
4. **Scratch conversations.** One-off conversations outside Projects run in isolated local scratch folders with their own settings and permissions layered over global permissions. (`Feature Overview`)
5. **Scheduling.** Antigravity 2.0 supports repeatable time-based scheduled messages to agents, using the documented Gemini model selection for that feature. (`Feature Overview`)
6. **Security controls.** Default settings ask for explicit terminal-command approval and bound file read/write access to project folders; broader Full Machine and Unrestricted presets expand access. Permissions can be persisted per project. (`Feature Overview`)
7. **Browser agent.** The browser subagent is invoked on demand through `/browser`, integrates with Chrome DevTools MCP, and can create WebM recordings. (`Feature Overview`)
8. **Artifacts.** Agents produce structured plans, code diffs, architecture diagrams, images, screenshots, and browser recordings as reviewable deliverables rather than requiring users to inspect every tool call. (`Artifacts Overview`; launch blog)
9. **Feedback loop.** The desktop app provides visual organization and review panes for Artifacts, supports inline feedback, and can pause at configured plan or code milestones for approval before continuing. (`Artifacts Overview`)
10. **Input and editor features.** The launch product included IDE tab completion and inline commands; version 2.0 documents live voice transcription and cleaned-up voice feedback across agent prompts and Artifact comments. (`Build with Google Antigravity`; `Feature Overview`)
11. **Hooks.** JSON Hooks can run local scripts before tool calls, after model responses, or at loop-stop boundaries, configured globally or per workspace. (`Feature Overview`)
