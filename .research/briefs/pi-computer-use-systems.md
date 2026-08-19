---
id: pi-computer-use-systems
kind: research-brief
summary: Krometrail already covers browser screenshots; for native desktop screenshots, existing Pi extensions include a minimal ~40–50 MB Cua-backed one-tool wrapper and a richer semantic multi-app extension, so a new browser or capture package is unnecessary.
updated: 2026-08-18
source_handles: [pi-core-computer-use-capabilities, krometrail-current-capabilities, edward40-pi-computer-use, injaneity-pi-computer-use, pi-screenshots-picker, pi-playwright-skill, pi-browser-playwright-extension, pi-chrome-use-extension, pi-chrome-operator, computer-use-scout-playwright-mcp, computer-use-scout-cua-driver, computer-use-scout-browser-use, computer-use-scout-skyvern, computer-use-scout-agent-s, computer-use-scout-self-operating-computer, codex-desktop-computer-use, claude-code-desktop-computer-use, antigravity-2-computer-use]
relationships: []
---

# Pi computer-use systems

## Decision boundary

This brief answers two related questions:

1. Which current browser and full-desktop systems are good candidates for use from Pi?
2. How much of a Codex-, Claude Code Desktop-, or Antigravity-style experience would those systems provide?

To bound the comparison, this brief analyzes a local-first coding scenario and uses model independence, direct Pi or MCP integration, inspectable actions, browser/profile isolation, user intervention, and avoidance of nested agent loops as analyst-selected criteria. These are evaluation assumptions, not requirements supplied by the user. The brief does not select a hosted browser vendor, benchmark model accuracy, or design a production implementation.

## Executive conclusion

**Inference:** None of the surveyed systems is an off-the-shelf Codex-like desktop app for Pi. Pi Chrome Operator is the closest existing browser-side operator interface, but it runs a separate browser-focused Pi process and does not manage the user's coding session. For capability composed into an existing Pi coding session, the strongest documented approach is a layered stack: a lean browser Skill, an optional persistent or attached-browser tool, and a full-desktop fallback. That stack adds computer use, but not the multi-project orchestration, worktree management, review panes, schedules, or graphical permission experience supplied by Codex and Claude Code Desktop.

### Applied to the existing Krometrail setup

The user's clarified need is primarily screenshots with only light orchestration, and Krometrail is already available.

**Inference:** In that situation, Pi does **not** need another browser package. Krometrail already provides ordinary viewport, full-page, element, and region screenshots; post-action visual observations; structured page snapshots; Chromium browser control; page/target tracking; ordered batches; and continuous temporal evidence when one screenshot misses a transient state. [krometrail-current-capabilities]{1}{2}{3}{4}{6}

The smaller stack is therefore:

1. **Krometrail for browser screenshots and browser actions.** Use normal screenshots for current state and its temporal bundle or source frames only when motion, flicker, or a short-lived state matters. [krometrail-current-capabilities]{2}{3}
2. **Pi plus the existing subagent/background surfaces for light orchestration.** Krometrail's own session, target, batch, and interaction anchors cover orchestration inside a browser task; Pi remains responsible for coding-session or agent coordination. [krometrail-current-capabilities]{6}{10}
3. **Cua Driver only if “computer screenshots” means arbitrary native applications or the whole desktop.** Krometrail deliberately stops at Chromium and debug-enabled Electron renderers, whereas Cua Driver documents native app, window, accessibility, screenshot/recording, and input tools. [krometrail-current-capabilities]{9} [computer-use-scout-cua-driver]{1}{3}
4. **No Codex-like desktop shell unless the desired scope grows.** Project dashboards, worktree handoff, schedules, graphical diffs, and cross-session supervision are separate product features, not prerequisites for screenshot-oriented computer use.

For readers without Krometrail, the broader candidate comparison below remains useful. Under the local-first and low-duplication assumptions stated above, a generic stack would pair a lean Playwright browser surface with an optional attached-browser tool and Cua Driver for native desktop fallback.

### Existing Pi extensions for native screenshots

The missing piece is already packaged for Pi:

| Extension | Practical footprint | Screenshot and action surface | Fit for this request |
|---|---|---|---|
| **`@edward40/pi-computer-use`** | Free/MIT. One 34 KB Pi wrapper plus Cua's 0.6 MB SDK and the selected native library: about 38.8 MB unpacked on Linux x64 or 49.2 MB on macOS, before shared npm dependencies and filesystem overhead. No daemon, executable, MCP process, or Cua cloud service. [edward40-pi-computer-use]{2}{7}{8} | Exactly one `computer` tool: screenshot plus click, double-click, scroll, type, wait, move, keypress, and drag. Every action returns a fresh PNG; operations are sequential. [edward40-pi-computer-use]{1}{3} | **Closest feature match for “screenshots mostly, a little orchestration,” but very new: its two public `0.1.x` releases shipped on one day.** [edward40-pi-computer-use]{10} |
| **`@injaneity/pi-computer-use`** | Free/MIT; npm reports about 14.9 MB unpacked, with platform helpers included. [injaneity-pi-computer-use]{6}{7} | Semantic app/window discovery, observation, search, inspection, checked action batches, waits, successor-state diffs, and per-resource concurrency across macOS, Windows, and Linux. Its current API is state-centric rather than a direct screenshot tool. [injaneity-pi-computer-use]{1}{2}{3}{4} | Better when the “little orchestration” grows into reliable multi-app operation. More machinery than needed for raw captures. |
| **`pi-screenshots-picker`** | Small terminal UI package | Lets a human browse and attach screenshot files already on disk; it does not capture or control the desktop. [pi-screenshots-picker]{1}{2}{4} | Useful companion for manual screenshots, not agent computer use. |

The minimal Cua wrapper's important limitations are primary-display-only coordinate control, no app/window targeting, no multi-monitor model, and no per-action confirmation dialog; it runs Cua's promptless standard mode after operating-system permissions are granted. [edward40-pi-computer-use]{4}{5}

## Candidate comparison

### Browser and desktop execution engines

| System | Scope and Pi path | Strongest features | Important gaps or risks | Verdict |
|---|---|---|---|---|
| **`pi-playwright`** | Browser; native Pi Skill invoking local Playwright CLI | Small model-facing surface; DOM interaction, forms, screenshots, console/network output, auth-state saving, per-repository sessions and artifacts [pi-playwright-skill]{1}{2}{3}{4}{5} | No built-in browser UI, desktop control, or rich Pi session manager; capability is mediated through Skill instructions and shell-invoked CLI commands [pi-playwright-skill]{8} | **Lean default candidate for coding and web-app verification** |
| **Playwright MCP** | Browser; standard-I/O MCP through Pi's MCP adapter | Accessibility-tree interaction without mandatory vision; deterministic structured tools; Chromium/Firefox/WebKit; persistent, isolated, seeded, CDP, and existing-profile modes; workspace file bounds [computer-use-scout-playwright-mcp]{1}{2}{4}{6} | Browser-only. Its own project says CLI Skills are often more token-efficient for coding agents [computer-use-scout-playwright-mcp]{3} | **Structured general-purpose browser MCP** |
| **`pi-browser`** | Browser; native Pi extension | More than 50 structured tools; accessibility refs plus screenshots; existing Chromium session; forms, uploads, console, network mocking, cookies, and storage [pi-browser-playwright-extension]{1}{2}{4}{5}{6} | Large tool surface; remote-debugging setup; Chromium-only; cross-window and extension-context limitations [pi-browser-playwright-extension]{7}{8}{9} | **Broad Pi-native attached-browser option** |
| **`pi-chrome-use`** | Browser; one native Pi `browser_execute` tool over CDP | Compact tool schema; arbitrary JavaScript/CDP access; console streaming; screenshots as Pi images; persistent authorized browser state; reusable scripts [pi-chrome-use-extension]{1}{2}{3}{4}{5}{6} | The project warns against untrusted pages and untrusted CDP endpoints because CDP controls the connected browser [pi-chrome-use-extension]{8} | **Compact code-oriented attached-browser option** |
| **Pi Chrome Operator** | Browser; separate Chrome side panel, bridge daemon, and focused Pi RPC process | Browser-native chat UI, all-tab operation, images, model selector, saved routines, rich-editor support [pi-chrome-operator]{1}{2}{3}{6} | Separate browser-only Pi rather than capability composed into the current coding session; unpacked extension plus daemon; early package with no declared test script [pi-chrome-operator]{7}{8}{9} | **Browser-side operator UI; separate from the current coding session** |
| **Cua Driver** | Full desktop plus browser; standard-I/O MCP | 50+ native app, window, accessibility, browser, input, recording, session, and replay tools; bounded manifests; background control; optional VM/cloud sandboxes [computer-use-scout-cua-driver]{1}{3}{4}{7} | Linux is explicitly pre-release; macOS permission attribution constrains process architecture; no built-in authorization dialog [computer-use-scout-cua-driver]{5}{10} | **Promising model-independent desktop MCP candidate** |
| **Browser Use** | Browser; Python library, CLI Skill, or MCP | Direct tools plus autonomous fallback; many model providers including local; domain restriction; screenshots, GIF, video, HAR, and optional tracing [computer-use-scout-browser-use]{2}{3}{5}{7}{8} | Python 3.11+ runtime; its autonomous MCP fallback introduces a second agent loop that overlaps Pi's under this brief's assumptions; product messaging favors paid cloud [computer-use-scout-browser-use]{2}{3}{9} | **Autonomous workflow platform; overlaps Pi's reasoning loop under this brief's assumptions** |
| **Skyvern** | Browser; local/cloud MCP and persistent server | Natural-language and selector hybrid actions; workflow builder; credentials and TOTP; many scoped tools; live viewport intervention; local Chrome sharing [computer-use-scout-skyvern]{2}{3}{4}{6}{7} | Local operation requires a Python server and SQLite or Postgres; AGPL; managed anti-bot, proxy, and CAPTCHA capabilities are cloud offerings; some internals were not source-inspected [computer-use-scout-skyvern]{5}{9} | **Workflow-automation platform with a larger local or cloud service footprint** |
| **Agent S** | Full desktop; Python CLI/SDK, no MCP | Research-oriented GUI agent, memory, reflection, grounding, and multi-platform desktop operation [computer-use-scout-agent-s]{1}{2}{5}{6} | Requires main and grounding models; executes host Python/GUI actions without a documented approval or sandbox layer; no MCP server, so Pi integration would require a CLI or SDK wrapper [computer-use-scout-agent-s]{3}{4}{6}{9} | **Research-oriented system requiring a Pi integration wrapper** |
| **Self-Operating Computer** | Full desktop; CLI only | Simple screenshot/OCR/coordinate loop; historically important full computer-use example [computer-use-scout-self-operating-computer]{1}{2} | Directly controls the real session without guards, no MCP/SDK surface; the fetched repository's latest commit was 2025-09-19 and its documented model list remained GPT-4o/GPT-4.1/o1/Claude 3-era [computer-use-scout-self-operating-computer]{3}{4}{5}{7} | **Poor documented fit for routine Pi integration** |

### Why the CLI-versus-MCP distinction matters

Playwright MCP's own documentation says coding agents increasingly prefer CLI workflows packaged as Skills because they use fewer tokens, while retaining MCP for persistent state and rich iterative inspection. [computer-use-scout-playwright-mcp]{3} `pi-playwright` embodies the first approach; Playwright MCP embodies the second.

**Inference:** Pi should not choose one globally. A good policy is:

- use a Skill/CLI for routine local preview and scripted checks;
- activate MCP only when the task needs a continuing browser, rich page-state iteration, or interoperability;
- attach to the user's real profile only by explicit request;
- reserve arbitrary CDP/JavaScript execution for trusted sites and tightly scoped tasks.

## What the desktop apps provide beyond computer control

| Product | Agent/project control | Review and artifacts | Browser and desktop use | Automation and environments |
|---|---|---|---|---|
| **Codex / ChatGPT desktop** | Parallel project chats; managed and permanent Git worktrees; Local↔Worktree handoff and snapshot recovery [codex-desktop-computer-use]{1}{2} | Git review pane, inline comments, agent review, stage/revert by diff, file, or hunk [codex-desktop-computer-use]{3} | Separate-profile built-in browser, existing-profile Chrome extension, full CDP developer mode, and approved macOS/Windows desktop control [codex-desktop-computer-use]{6}{7}{8} | Scheduled tasks with worktrees, skills, plugins, configurable sandboxing, native Windows or WSL execution [codex-desktop-computer-use]{4}{5}{10}{11} |
| **Claude Code Desktop** | Parallel sessions with automatic worktrees; cross-session inspection and messaging; side chats; local, cloud, SSH, and WSL environments [claude-code-desktop-computer-use]{1}{7}{8} | Arrangeable chat/diff/browser/terminal/file/plan/task/subagent panes; inline diff comments; code review; CI auto-fix/merge [claude-code-desktop-computer-use]{2}{3} | Auto-verifying local preview, clean-profile external browser, Chrome route for personal sessions, and native app control with app-specific access tiers [claude-code-desktop-computer-use]{4}{5}{6} | Local scheduled sessions, cloud routines, connectors, MCP, skills, and plugin manager [claude-code-desktop-computer-use]{9}{10} |
| **Google Antigravity 2.0** | Editor plus multi-agent Manager; project worktrees; multi-folder projects; project-scoped settings and permissions [antigravity-2-computer-use]{1}{3}{6} | Structured plans, diffs, diagrams, screenshots, and browser recordings with visual review and inline steering [antigravity-2-computer-use]{8}{9} | Agent work across editor, terminal, and browser; on-demand browser subagent with Chrome DevTools MCP and video [antigravity-2-computer-use]{2}{7} | Repeatable schedules, scratch conversations, hooks, voice prompts and Artifact feedback [antigravity-2-computer-use]{4}{5}{9}{10}{11} |

Important limits qualify this comparison. Codex Computer Use cannot automate terminal applications or ChatGPT itself, approve operating-system security prompts, or authenticate as an administrator; Windows control occupies the active foreground desktop. [codex-desktop-computer-use]{9} Claude Code Desktop restricts browsers to view-only and terminals and IDEs to click-only under native computer use, and computer use is unavailable in its Linux desktop app. [claude-code-desktop-computer-use]{6}{11} The fetched Antigravity evidence documents editor, terminal, and browser operation, including a browser subagent, but does not establish general native-app desktop control. [antigravity-2-computer-use]{2}{7}

### Current Pi position

Pi's core is intentionally a minimal terminal harness with file and shell tools, session trees, branching, forks, steering, Skills, packages, TypeScript extensions, RPC, and an embeddable SDK. [pi-core-computer-use-capabilities]{1}{2}{5}{6}{7}{9} Extensions can implement rich terminal dialogs, overlays, images, widgets, and custom editors, but the documented UI remains terminal-based. [pi-core-computer-use-capabilities]{8}

This repository already narrows two important gaps through its maintained subagent and MCP packages. Those pieces supply execution and orchestration primitives, but they are not a graphical project shell.

**Inference:** Against the desktop products, Pi is already strong on model choice, extensibility, scriptability, session history, and composable tools. Its material gaps are:

1. one visual project/task inbox across several sessions;
2. automatic worktree creation, lifecycle, and handoff;
3. first-class diff, browser, recording, and Artifact review panes;
4. durable local schedules and unattended-run review queues;
5. graphical app/site permission management;
6. a shared live browser or desktop view with takeover/intervention;
7. optional remote or persistent execution when the local terminal exits.

Playwright and Cua add browser or desktop execution toward item 6, but neither supplies the graphical grant-management experience in item 5, and neither consistently supplies a shared live takeover view. Skyvern documents live viewport intervention, but at the cost of a larger workflow-server architecture. None of these tools closes Pi's orchestration and review gaps. [computer-use-scout-cua-driver]{4} [computer-use-scout-skyvern]{6}

## Recommended path

### Use now

- Keep **Krometrail** as the only browser-control and browser-screenshot system. Adding `pi-playwright`, Playwright MCP, `pi-browser`, or `pi-chrome-use` would mostly duplicate its current-state browser control and visual-observation surface. [krometrail-current-capabilities]{1}{2}{4}
- Trial **`@edward40/pi-computer-use`** if the actual gap is whole-desktop screenshots with occasional coordinate actions. It is already the narrow same-process Cua integration this brief had proposed abstractly, but its public release history is only two same-day `0.1.x` versions. [edward40-pi-computer-use]{1}{2}{3}{10}
- Prefer **`@injaneity/pi-computer-use`** for the more established option, or when app/window selection, semantic controls, verified actions, background-first input, or independent-root concurrency matter more than a simple screenshot call. [injaneity-pi-computer-use]{1}{4}{5}{10}
- Use Krometrail's temporal bundles, region filmstrips, or source frames only when browser behavior changes over time. [krometrail-current-capabilities]{2}{3}
- Do not put Agent S or Self-Operating Computer on the user's primary desktop as the normal Pi path.

### If the goal is a Codex-like Pi desktop

**Inference:** No surveyed package supplies that complete experience. Pi's SDK and RPC modes provide plausible runtime boundaries for a separate graphical shell, while Playwright and Cua could remain replaceable execution providers. The shell would at minimum need project/session supervision, worktree lifecycle, artifact and diff review, schedules, and graphical capability grants. Choosing its architecture is a separate design decision outside this comparison.

## Disconfirming evidence

- A large structured MCP surface is not automatically better. Playwright's own project explicitly positions its CLI Skill as more token-efficient for coding agents. [computer-use-scout-playwright-mcp]{3}
- `pi-browser` already supplies an unusually broad Pi-native browser surface, so building a new browser tool from scratch would duplicate existing work. [pi-browser-playwright-extension]{2}
- `pi-chrome-use` shows that one code-oriented tool can keep browser context compact while retaining CDP power; a many-tool design is not required. [pi-chrome-use-extension]{1}{2}
- Browser Use and Skyvern provide more autonomous workflow machinery and stronger hosted-operation stories than the recommended lean stack. [computer-use-scout-browser-use]{3}{9} [computer-use-scout-skyvern]{3}{4}{6} They become better choices if the decision changes from “extend Pi's own agent loop” to “delegate whole browser jobs to a specialized browser platform.”
- Claude Code Desktop now documents full computer use, a browser, schedules, cross-session operation, cloud/SSH execution, and rich panes in one product. [claude-code-desktop-computer-use]{2}{6}{7}{8}{9} This weakens any claim that Codex is uniquely broad and raises the parity bar above browser automation alone.
- Antigravity demonstrates a credible artifact-first alternative to raw tool-log observability. [antigravity-2-computer-use]{8}{9} A Pi desktop should not assume a chat transcript plus screenshots is sufficient review UX.
- Cua's Linux support remains explicitly pre-release, and macOS permissions require deliberate process identity. [computer-use-scout-cua-driver]{5}{10} It is not yet a universal drop-in backend.
- **Tension:** Cua Driver is the most promising documented model-independent desktop MCP candidate, but its default `standard` mode is promptless and it renders no authorization dialog. Bounded manifests constrain capabilities, but they do not provide the interactive permission UX used by the desktop products. [computer-use-scout-cua-driver]{4}
- **Qualification:** Skyvern directly documents live viewport intervention, one of the identified Codex-like experience gaps. Its exclusion from the lean recommendation follows the brief's local-first, low-duplication assumptions—not an absence of the capability. [computer-use-scout-skyvern]{5}{6}

## Confidence and limits

Confidence is **medium-high** on documented feature shape and **medium** on operational recommendations. Several vendor attestations aggregate multiple current documentation pages rather than immutable source revisions, and none of the candidate systems was run in this environment.

The named projects were inspected from current primary documentation or fetched source revisions. None were run in this environment. Vendor benchmark claims were deliberately excluded from the ranking because they were not independently verified. Skyvern was too large for source cloning, so its evidence is limited to its README and MCP documentation. Playwright MCP's implementation resides in the larger Playwright monorepo; the packaging repository, tests, and documentation were inspected instead. Full-desktop permission behavior is especially platform-dependent and should be validated on the actual macOS, Windows, or Linux setup before adoption.
