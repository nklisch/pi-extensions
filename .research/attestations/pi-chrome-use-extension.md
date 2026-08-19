---
source_handle: pi-chrome-use-extension
fetched: 2026-08-18
source_title: citrolabs/pi-chrome-use source repository
source_url: https://github.com/citrolabs/pi-chrome-use
---

The GitHub repository and README were fetched. This attestation records the package's documented capabilities and warnings without independently auditing its implementation.

## Attested details

1. **Integration shape.** `pi-chrome-use` registers one `browser_execute` tool in Pi and maintains a persistent Chrome DevTools Protocol session inside the Pi process rather than hosting a separate daemon. (`README.md`, introduction)
2. **Code-oriented control.** The model can execute JavaScript against a user-authorized Chromium browser, drive pages, inspect live DOM state, and directly invoke DevTools Protocol behavior. (`README.md`, introduction and What it gives Pi)
3. **Visual feedback.** Successful screenshot captures are converted into Pi image results and can optionally be saved to disk. (`README.md`, What it gives Pi and Configuration)
4. **Diagnostics.** Browser console log, error, warning, information, and debug output is captured and streamed in tool results. (`README.md`, What it gives Pi)
5. **Persistent state.** Multiple calls in one Pi session reuse browser state, including the authorized browser's login state and browser behavior. (`README.md`, What it gives Pi and comparison table)
6. **Reusable scripts.** Browser code snippets can import reusable workspace modules from `.pi/browser-execute-workspace`. (`README.md`, What it gives Pi)
7. **Scope boundary.** The project says it is not a standalone testing framework and recommends Playwright or Vitest for pure tests; its purpose is hands-on operation of a live browser. (`README.md`, introduction and Who should use this)
8. **Security warning.** The project warns against untrusted pages and untrusted CDP endpoints because CDP controls the connected browser. (`README.md`, Who should use this)
9. **Verification surface.** The repository documents typecheck and tests for session reuse and isolation, workspace imports, console streaming, timeouts, screenshot conversion, CDP target filtering, and session routing. (`README.md`, Validation)
10. **Fetched revision.** The fetched default branch resolved to commit `f9231eaa6fcb41b6754d620d9002e493f08d5782`, whose latest commit date was 2026-07-27. The MIT-licensed package declared version `1.1.1`, TypeScript typecheck, and Vitest test scripts. (Git metadata; `package.json`)
