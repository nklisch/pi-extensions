---
source_handle: codex-desktop-computer-use
fetched: 2026-08-18
source_title: OpenAI ChatGPT desktop app, Codex, Browser, Computer Use, worktree, review, automation, and skills documentation
source_url: https://developers.openai.com/codex/app
---

OpenAI's current official Codex and ChatGPT desktop documentation was fetched for the app overview, browser, Computer Use, Chrome extension, Git worktrees, code review, scheduled tasks, Windows support, and skills. This attestation records the documented product surface without assessing implementation quality.

Fetched documents:

- https://openai.com/index/introducing-the-codex-app/
- https://developers.openai.com/codex/app
- https://developers.openai.com/codex/app/worktrees
- https://developers.openai.com/codex/app/automations
- https://developers.openai.com/codex/app/windows
- https://developers.openai.com/codex/skills
- https://developers.openai.com/codex/app/browser
- https://developers.openai.com/codex/app/computer-use
- https://developers.openai.com/codex/app/review
- https://developers.openai.com/codex/app/chrome-extension

## Attested details

1. **Agent command center.** The desktop app organizes long-running chats by project, supports several concurrent agent threads, and presents files and other outputs inside one desktop workspace. (`ChatGPT desktop app`; `Introducing the Codex app`)
2. **Git isolation and handoff.** Codex can create managed or permanent Git worktrees for independent chats and scheduled tasks, carry uncommitted starting changes into a worktree, move a chat and its code between Local and Worktree through Handoff, and snapshot managed work before automatic cleanup. (`Worktrees`)
3. **Review loop.** The app has a Git-backed review pane with unstaged, staged, commit, branch, and last-turn scopes; inline comments; agent review; and stage, unstage, or revert actions at diff, file, and hunk granularity. It can surface GitHub pull-request context when `gh` is configured. (`Code review`)
4. **Scheduled work.** Scheduled tasks can run against local projects in the project directory or an isolated worktree, use skills and plugins, choose model and reasoning effort, recur with custom rules, and return findings to a Scheduled inbox or an existing chat. Local work requires the machine and app to remain running. (`Scheduled tasks`)
5. **Reusable capabilities.** Skills package instructions, references, assets, and optional scripts using the Agent Skills standard, support explicit or implicit invocation, and can be distributed with connectors through plugins. The app provides skill discovery and creation interfaces. (`Build skills`; `Introducing the Codex app`)
6. **Built-in browser.** The app provides a shared, separate-profile browser for signed-in or public sites and local previews. The agent can open pages, inspect rendered state, click, type, take screenshots, verify work, accept element or region annotations, and—when explicitly approved—use full Chrome DevTools Protocol access for DOM, console, network, and performance diagnostics. Automated file upload is not supported in the built-in browser. (`Browser`)
7. **Existing-profile browser.** A Chrome extension lets ChatGPT use existing signed-in tabs and context, operate task-scoped tab groups, and apply per-site permission, allowlist, and blocklist controls. (`Chrome extension`)
8. **Full desktop control.** The Computer Use plugin can view and operate approved macOS or Windows applications through screenshots, windows, menus, pointer, keyboard, and clipboard. It is intended for GUI-only tasks and multi-app workflows, while structured plugins, shell tools, and the built-in browser are preferred when applicable. (`Computer Use`)
9. **Computer-use boundaries.** On Windows, control takes over the active foreground desktop; on macOS, locked use can run through a narrowly scoped authorization flow. Computer Use cannot automate terminal apps or ChatGPT itself, authenticate as an administrator, or approve operating-system security prompts. App and sensitive-action approvals remain separate from file/shell sandbox settings. (`Computer Use`)
10. **Security posture.** Codex uses configurable system sandboxing, defaults agents to project or branch file access plus cached web search, asks before elevated command or network access, and supports command rules. Browser and desktop surfaces add site, app, and sensitive-action prompts. (`Introducing the Codex app`; `Browser`; `Computer Use`)
11. **Windows parity claim.** OpenAI documents the Windows app as supporting worktrees, scheduled tasks, Git, built-in browser, file previews, plugins, skills, an integrated terminal, and either native PowerShell or WSL2 agent execution. (`ChatGPT desktop app for Windows`)
