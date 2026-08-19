---
source_handle: pi-browser-playwright-extension
fetched: 2026-08-18
source_title: larsderidder/pi-browser source repository
source_url: https://github.com/larsderidder/pi-browser
---

The repository README and source layout were fetched from GitHub. This attestation records the extension's documented surface and limitations; it does not claim independent reliability or security validation.

## Attested details

1. **Integration shape.** `pi-browser` is a Pi TypeScript extension backed by Playwright. It can launch Chromium or attach over the Chrome DevTools Protocol to an already running Chrome, Chromium, Brave, Edge, Opera, Arc, or Vivaldi instance. (`README.md`, introduction and Browser setup)
2. **Broad structured tools.** The extension documents more than 50 Pi tools for navigation, accessibility snapshots, screenshots, element and coordinate interaction, forms, tabs, console messages, dialogs, network observation and interception, cookies, local/session storage, JavaScript evaluation, waits, resize, and file upload. (`README.md`, Tools)
3. **Shared visible browser.** Its main differentiator is attachment to a browser the user already has open, preserving visible state and login context rather than always launching an isolated browser. (`README.md`, introduction)
4. **Agent observation modes.** Accessibility snapshots return stable element references for structured interaction, while screenshots support visual inspection. (`README.md`, Observation and Interaction)
5. **Developer diagnostics.** Console capture, network request history, online/offline emulation, and request mocking make the surface useful for debugging and verification in addition to website operation. (`README.md`, Console, Dialogs, and Network)
6. **State control.** The model can inspect and mutate cookies and web storage and save or restore browser storage state. (`README.md`, Storage)
7. **Operational setup.** Attaching requires starting the browser with a remote-debugging port; the extension exposes slash commands to connect, launch, inspect status, and disconnect. (`README.md`, Browser setup and Usage)
8. **Documented limitations.** Only Chromium-family browsers are supported; tabs in other browser windows cannot always be controlled in place because of a Playwright CDP limitation; browser extensions run in an isolated context unreachable over this connection. (`README.md`, Notes)
9. **Tool-context cost.** The documented design exposes dozens of distinct tool definitions once connected rather than one compact action or code-execution surface. (`README.md`, Tools; `src/tools/` repository layout)
10. **Fetched revision.** The fetched default branch resolved to commit `32b5baaf7ca0d6258b1d0841cff9c6c88aafff2b`, whose latest commit date was 2026-07-09. The MIT-licensed package declared version `0.1.0` and a Vitest test command. (Git metadata; `package.json`)
