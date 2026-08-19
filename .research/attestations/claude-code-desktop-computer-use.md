---
source_handle: claude-code-desktop-computer-use
fetched: 2026-08-18
source_title: Anthropic Claude Code Desktop and scheduled-task documentation
source_url: https://code.claude.com/docs/en/desktop
---

Anthropic's current official Claude Code Desktop reference, redesign announcement, and local scheduled-task guide were fetched. This attestation records the documented Code-tab feature surface and explicit limitations.

Fetched documents:

- https://code.claude.com/docs/en/desktop
- https://code.claude.com/docs/en/desktop-scheduled-tasks
- https://claude.com/blog/claude-code-desktop-redesign

## Attested details

1. **Session workspace.** Each desktop Code session has its own conversation, project folder, context, and changes. The sidebar runs several sessions in parallel, and Git projects use automatic worktrees so changes remain isolated. (`Desktop application`, Start a session and Work in parallel)
2. **Composable panes.** Users can arrange chat, diff, browser, terminal, file editor, plan, task, subagent, and supported simulator panes side by side by dragging and resizing them. (`Desktop application`, Arrange your workspace)
3. **Integrated review and delivery.** The app provides line-commentable diffs, agent code review, a local file editor, an integrated terminal, pull-request CI status, optional automatic CI repair and merge, desktop notifications, and automatic session archival after PR completion. (`Desktop application`, Work with code)
4. **Web preview and verification.** Claude can start configured development servers, interact with the local app in a browser pane, inspect the DOM, click and fill forms, capture screenshots, view logs, preserve cookies/local storage, and automatically verify after edits. (`Desktop application`, Preview your app and Configure preview servers)
5. **External browser tasks.** The browser pane can open external sites in a clean profile; first action per site requires permission, organization controls can restrict navigation or tools, and signed-in personal browser work is routed to the separate Claude in Chrome extension. (`Desktop application`, Browse external sites)
6. **Full computer use.** When enabled, Claude can open approved native apps and control the screen. It prefers connectors, shell, browser-specific tooling, and the iOS Simulator before this broad and slower fallback. Per-app tiers are fixed: browsers view-only, terminals and IDEs click-only, and most other apps full control. (`Desktop application`, Let Claude use your computer)
7. **Multi-environment execution.** Sessions can run locally, on continuing Anthropic-managed cloud infrastructure, over SSH, or in WSL2 on Windows. Local configuration and tools differ by environment. (`Desktop application`, Start a session and Environment configuration)
8. **Cross-session operation.** Claude can inspect, message, rename, and—after confirmation—archive other desktop Code sessions; the tasks pane exposes subagents and background commands inside the current session. Side chats use current context without changing or persisting into the main conversation. (`Desktop application`, Manage sessions)
9. **Scheduling.** Desktop local scheduled tasks create fresh sessions, can use isolated worktrees, choose a model and permission mode, run every minute or on broader schedules, preserve task history, and store prompt instructions in a `SKILL.md`. They require the machine awake and app open; remote routines run in the cloud and add API or GitHub event triggers. (`Schedule recurring tasks`)
10. **Customization.** Local and SSH sessions support graphical connector setup, Agent Skills, MCP servers, and plugin installation/management. Plugins can include skills, agents, hooks, MCP servers, and language-server configuration. (`Desktop application`, Extend Claude Code)
11. **Explicit limits.** Desktop is interactive-only and lacks CLI print/output automation, inline code completion, and CLI agent teams. Computer Use is not yet available in the Linux desktop app. (`Desktop application`, Feature comparison and What's not available)
12. **Permission modes.** Desktop offers Manual, Accept edits, Plan, Auto, and optionally Bypass permissions, with organization controls and per-folder settings; Auto uses safety checks and Bypass is recommended only in sandboxes or virtual machines. (`Desktop application`, Choose a permission mode)
