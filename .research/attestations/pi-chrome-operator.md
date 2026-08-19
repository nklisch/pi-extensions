---
source_handle: pi-chrome-operator
fetched: 2026-08-18
source_title: patriceckhart/pi-chrome-operator source repository
source_url: https://github.com/patriceckhart/pi-chrome-operator
---

The GitHub repository and README were fetched. This attestation records the project's documented product and architecture without independently auditing its security or maintenance maturity.

## Attested details

1. **Browser-native interface.** Pi Chrome Operator is a Chrome extension with a side-panel chat interface, model selector, image input, and saved one-click routines. (`README.md`, introduction and Features)
2. **Pi bridge architecture.** A local bridge starts Pi in RPC mode with coding tools disabled, loads a Pi extension that registers one structured `browser_action` tool, and relays model actions to Chrome over HTTP and WebSocket. (`README.md`, How it works)
3. **Multi-tab operation.** The agent can list, inspect, navigate, switch, and close all open browser tabs, with optional explicit tab targeting. (`README.md`, Multi-Tab Browser Control)
4. **Page actions.** The structured tool supports DOM context extraction, click, type and submit, select, scroll, text extraction, waits, and tab creation. (`README.md`, Available actions)
5. **Authenticated context.** Because actions run through a Chrome extension and content scripts in the user's browser, the design operates existing tabs and their browser state rather than an isolated automation profile. (`README.md`, architecture and Multi-Tab Browser Control)
6. **Rich editor handling.** The project documents dedicated insertion handling for Monaco, CKEditor, ProseMirror/Tiptap, TinyMCE, and generic editable elements using editor APIs and fallbacks. (`README.md`, Rich Editor Support)
7. **Focused-agent tradeoff.** The bundled Pi process is intentionally configured as a browser-only operator without built-in file or coding tools. It is therefore a separate browser-agent shell rather than computer use composed into the user's current Pi coding session. (`README.md`, Dedicated Browser Agent and architecture)
8. **Operational footprint.** Users must install an unpacked Chrome extension and run a local bridge daemon. The project requires Chrome 116 or newer and a separately configured Pi installation. (`README.md`, Install, Setup, Requirements)
9. **Fetched revision.** The fetched default branch resolved to commit `72c2527d3606adf3dec3e6c11fc21d84720dddb5`, whose latest commit date was 2026-04-15. The MIT-licensed package declared version `0.0.13`; its manifest listed build and lint scripts but no test script. (Git metadata; `package.json`)
