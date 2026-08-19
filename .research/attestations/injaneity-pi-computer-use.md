---
source_handle: injaneity-pi-computer-use
fetched: 2026-08-18
source_title: injaneity/pi-computer-use source and npm metadata at commit de72583
source_url: https://github.com/injaneity/pi-computer-use/tree/de725835d3b0e3bd13aa8885d6c3f3a9dc23bcdc
---

The GitHub repository was cloned and its README, usage guide, architecture/source layout, package manifest, and npm metadata were inspected. The fetched default branch resolved to commit `de725835d3b0e3bd13aa8885d6c3f3a9dc23bcdc` (latest commit 2026-08-18). The MIT package was version `0.5.0`.

## Attested details

1. **Purpose.** `@injaneity/pi-computer-use` is a native Pi extension for desktop applications on macOS, Windows, and Linux. It exposes app/window discovery, semantic observation and search, detailed inspection, text reading, checked actions, and UI-condition waits. (`README.md`, What this package does and Main tools)
2. **Current public surface.** The current tools are `find_roots`, `observe_ui`, `search_ui`, `expand_ui`, `inspect_ui`, `act_ui`, `read_text`, and `wait_for`, plus browser-specific launch/navigation/evaluation tools in the usage guide. Older direct `screenshot`, `click`, `set_text`, and `computer_actions` tools are explicitly retired from the public extension surface. (`README.md`, Main tools and Development status; `docs/usage.md`, Tools)
3. **Visual observation.** `observe_ui` supports `semantic`, default `fused`, and `visual` modes; visual mode forces visual text evidence. Desktop nodes can be `pictureOnly`, and coordinate actions require a current image-bearing desktop state. (`docs/usage.md`, Progressive disclosure and Refs and state)
4. **Light orchestration.** Immutable state IDs and element references support inspect-then-act flows. `act_ui` accepts sequential action batches, optional verified postconditions, one final observation, and compact successor-state diffs. Live work is ordered per physical resource while independent desktop processes or browser pages may run concurrently. (`docs/usage.md`, Acting and batching, Successor views, Parallel calls)
5. **Background-first interaction.** The runtime prefers credible platform accessibility semantics, verifies results, and can escalate failed side-effect-free keyboard input; ambiguous pointer actions are not replayed blindly. (`docs/usage.md`, Acting and batching)
6. **Platform shape.** macOS uses a per-user helper and requires Accessibility plus Screen Recording; Windows uses platform accessibility APIs in an interactive desktop; Linux uses AT-SPI2 semantics, X11 capture/input where available, and semantic-only native Wayland. (`README.md`, Install)
7. **Footprint.** npm registry metadata reports 14,933,124 unpacked bytes for package version `0.5.0`. The package carries platform helpers and declares no ordinary npm dependency in the queried metadata. (`npm view`, 2026-08-18; `package.json`)
8. **Quality surface.** The package declares typecheck, schema, output-bound, lifecycle, runtime-concurrency, invariant, platform, Linux-script, signing, and macOS helper-path checks, plus optional live Linux checks. (`package.json`, scripts)
9. **Tradeoff for screenshot-first use.** The current design is semantic and state-centric rather than a one-call screenshot tool. A user wanting mostly raw desktop PNGs gets more state, accessibility, search, verification, and orchestration machinery than the minimal Cua wrapper provides. (`README.md`, Development status; `docs/usage.md`, normal loop)
10. **Release history.** npm metadata lists releases from `0.1.0` on 2026-04-22 through `0.5.0` on 2026-07-26, and the fetched source had a 2026-08-18 fix commit. This is a longer public change history than the minimal Cua wrapper's two same-day `0.1.x` releases. (`npm view time`; Git metadata, 2026-08-18)
