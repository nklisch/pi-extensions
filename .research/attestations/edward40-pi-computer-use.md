---
source_handle: edward40-pi-computer-use
fetched: 2026-08-18
source_title: SASUKE40/@edward40 pi-computer-use source and npm metadata at commit 1c56ea3
source_url: https://github.com/SASUKE40/pi-computer-use/tree/1c56ea3f8fa7a274ad847bb3816e4f6d5454ae50
---

The GitHub repository was cloned and its README, package manifest, source layout, tests, and npm registry metadata were inspected. The fetched default branch resolved to commit `1c56ea3f8fa7a274ad847bb3816e4f6d5454ae50` (latest commit 2026-08-05). The MIT package was version `0.1.1`.

## Attested details

1. **Purpose.** `@edward40/pi-computer-use` is a Pi extension exposing exactly one OpenAI-compatible `computer` tool, backed by the same-process `@trycua/cua-driver` TypeScript SDK. It controls the visible primary desktop and returns a fresh PNG screenshot after every supported action. (`README.md`, introduction)
2. **Minimal runtime shape.** No Cua executable, daemon, or MCP server is required. The native SDK loads lazily and one Cua session is created per Pi extension/session instance. (`README.md`, introduction and Compatibility boundaries)
3. **Actions.** The tool supports screenshot, click, double-click, scroll, type, two-second wait, pointer move, key or key-chord press, and drag. Calls execute sequentially, use Pi cancellation, and return a fresh screenshot after uncertain failure. (`README.md`, Use and Coordinate and action semantics)
4. **Scope limits.** It exposes the primary desktop only, not separate monitors or app/window targets. It does not expose clipboard, window management, session escalation, Cua's full tool inventory, or app-scoped accessibility operations; interaction is foreground coordinate-based mouse/keyboard plus screenshots. (`README.md`, Coordinate semantics and Compatibility boundaries)
5. **Permissions.** Cua runs in promptless `standard` mode and the extension adds no per-action confirmation. Operating-system permissions still apply. macOS requires Accessibility and Screen Recording grants on the actual process hosting Pi. (`README.md`, macOS permissions and Coordinate semantics)
6. **Platforms.** Documented native hosts are macOS 13+ arm64/x64, Windows arm64/x64, and glibc Linux arm64/x64. Other architectures and musl Linux fail at first tool use. (`README.md`, Requirements)
7. **Install footprint.** Registry metadata reports 34,078 unpacked bytes for the wrapper, 626,704 bytes for `@trycua/cua-driver@0.18.0`, and 38,772,974 bytes for the Linux x64 native package or approximately 49,186,341 bytes for either macOS native package. These figures exclude npm's shared dependencies and filesystem overhead. (`npm view`, 2026-08-18)
8. **Price and license.** The extension and Cua repository are MIT-licensed local software; this direct SDK path requires no hosted Cua service. Model/provider usage remains whatever the Pi session itself incurs. (`LICENSE`; `README.md`, runtime shape)
9. **Quality surface.** The package declares TypeScript checking, unit tests, package inspection, an opt-in native screenshot smoke test, and a real-Pi resource-loader screenshot smoke test. (`package.json`; `README.md`, Development)
10. **Maturity limit.** npm metadata shows the package was first published on 2026-08-06 and both `0.1.0` and `0.1.1` were published that day. Its focused tests are meaningful, but it has a short public release history. (`npm view time`, 2026-08-18)
