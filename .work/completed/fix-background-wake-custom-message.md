---
id: fix-background-wake-custom-message
kind: story
status: completed
tags: [bug, plugin]
created: 2026-06-22
completed: 2026-06-22
---

Background/monitor wake-ups were delivered via `pi.sendUserMessage`, so
completion wakes were attributed to the user. Routed wakes through
`pi.sendMessage` as `background-tasks:wake` custom messages with
`triggerTurn: true` and `deliverAs: "steer"`; wake content stays
hardcoded/status-only, with command output still gated behind the `jobs`
tool. Evidence: `WAKE_CUSTOM_TYPE` in
`packages/pi-background-tasks/extensions/background-tasks.ts` plus
regression assertions for custom-message wake metadata and zero
`sendUserMessage` calls. Work landed in nklisch/skills before the plugin
moved to this repo; item transferred from the skills repo's `.work/active`.
