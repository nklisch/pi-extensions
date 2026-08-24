---
release: subagent-lifecycle-resume-2026-08-24
date: 2026-08-24
packages:
  - "@nklisch/pi-subagents@18.1.0-nklisch.3"
  - "@nklisch/pi-plugins@0.4.2"
  - "@nklisch/pi-enhanced@0.2.3"
items:
  - subagent-session-lifecycle-and-resume
---

# Subagent lifecycle and resume reliability — 2026-08-24

Child sessions now follow Pi's managed teardown contract: extensions receive and
complete `session_shutdown` before `AgentSession.dispose()` revokes their context.
Detached child-owned jobs can cancel during shutdown instead of surviving as
orphans.

Resume now has one record-owned admission lease spanning aborted-run wind-down,
Pi's authoritative idle boundary, and the resumed turn. Concurrent requests are
rejected before reaching `AgentSession.prompt()`, while a terminal-looking record
whose prior prompt is still settling waits rather than producing the misleading
`Agent is already processing` failure. Retention, abort, result waiting, and
manager shutdown all recognize the reservation.

## Verification

- `@nklisch/pi-subagents`: 1,001 tests, typecheck, declaration build, and packed
  public-type verification passed.
- Full repository `npm run check` passed after synchronized versioning.
- Kimi K3 cross-model review found no material defects.
- A registry-downloaded `@nklisch/pi-enhanced@0.2.3` tarball contained
  `@nklisch/pi-plugins@0.4.2` and nested
  `@nklisch/pi-subagents@18.1.0-nklisch.3`.

## Publication receipts

Trusted-publishing workflow:
[GitHub Actions run 32732403164](https://github.com/nklisch/pi-extensions/actions/runs/32732403164),
successful from commit `8a7fb47f62dfe7e89c9f5454ec4ae28fb06dcfb0`.

- `@nklisch/pi-subagents@18.1.0-nklisch.3` — `sha512-k75p8+UnPaxQt7zsvrVRZ4p3an5Veae2NGaszYywhjGxLnZklo5fx75wU3yfcDzAeylLz9jtXM4xpBw0diacow==`
- `@nklisch/pi-plugins@0.4.2` — `sha512-6Z/vt0s5V3KyOv7Xvo47AnaZ5EgNBMH6foKftaTXhTtQssWOuluJ+WQz1MdwWnoZKKaY8lfeAsb7EmFeL+RD+A==`
- `@nklisch/pi-enhanced@0.2.3` — `sha512-Zn9ouS9cnW10kIr/6FbTFBfq4LIX1/aLL1I7Ht5Q+KNOSmOlFUBMeMJcTChbOjXk5DrfaxfyYsaRWmutlQQ2Fg==`
