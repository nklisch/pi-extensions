---
source_handle: pi-core-computer-use-capabilities
fetched: 2026-08-18
source_title: Pi coding agent README, extension, SDK, and TUI documentation
source_url: https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent
---

The installed Pi documentation was read in full for the core README, extensions, SDK, and TUI surfaces. This attestation records only capabilities documented by Pi itself; it does not claim that Pi ships browser or desktop control.

Fetched documents:

- https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/README.md
- https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/sdk.md
- https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/tui.md

## Attested details

1. **Minimal built-in tool set.** Pi describes itself as a minimal terminal coding harness. Its default model tools are file read, file write, exact edit, and shell execution; grep, find, and directory listing are additional built-ins. Computer or browser control is not listed as a core tool. (`README.md`, Quick Start and CLI Reference)
2. **Extension seam.** TypeScript extensions can register model-callable tools and commands, intercept lifecycle and tool events, prompt users, persist session state, customize rendering, replace built-in tools, and add custom terminal UI. Extensions run with the user's full system permissions. (`docs/extensions.md`, Key capabilities, Events, Custom Tools, Custom UI)
3. **Process and remote integration.** Extensions can execute subprocesses, replace built-in tool operations for SSH, containers, or sandboxes, and manage long-lived resources from session start through session shutdown. (`docs/extensions.md`, Long-lived resources, Remote Execution)
4. **Dynamic capabilities.** Extensions can register many tools while initially exposing a small loader surface, then activate additional tools during a session. Pi supports native deferred tool definitions for specified recent Anthropic and OpenAI model families and a complete-list fallback for other models. (`docs/extensions.md`, Dynamic Tool Loading)
5. **Embeddable runtime.** The SDK supports custom web, desktop, or mobile interfaces; custom tools; event streaming; model and reasoning controls; steering and follow-up messages; persistent session trees; and complete active-session replacement. (`docs/sdk.md`, overview and Core Concepts)
6. **Multiple integration modes.** Pi runs interactively, as print or JSON output, over an RPC protocol, or embedded through its SDK. (`README.md`, introduction and Programmatic Usage)
7. **Session model.** Native sessions are persistent JSONL trees with in-place branching, explicit forks and clones, compaction, model switching, queued steering, and follow-up messages. Pi does not document a built-in multi-project graphical session manager or automatic Git-worktree isolation. (`README.md`, Interactive Mode and Sessions)
8. **Terminal presentation ceiling.** Extensions can build dialogs, overlays, side panels, widgets, custom editors, image rendering in supported terminals, and complete replacement components, but the documented presentation surface remains a terminal UI rather than a native desktop windowing shell. (`docs/tui.md`; `docs/extensions.md`, Custom UI)
9. **Package portability.** Pi packages can bundle extensions and Agent Skills and install from npm or Git. Pi explicitly warns that packages and extensions can execute arbitrary code. (`README.md`, Pi Packages)
10. **Philosophy.** Pi intentionally omits built-in MCP, subagents, permission popups, plan mode, todos, and background shell support, directing users to extensions, packages, containers, or external process tools instead. (`README.md`, Philosophy)
