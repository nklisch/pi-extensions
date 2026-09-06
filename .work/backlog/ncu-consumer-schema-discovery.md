---
id: ncu-consumer-schema-discovery
tags: []
created: 2026-09-06
updated: 2026-09-06
---

# Pi MCP describe omits referenced crop fields and compact field guidance

- Kind: friction
- Status: open
- Observed/proposed: 2026-09-06
- Surface: MCP

## Goal or use case

Evaluate whether an agent can discover NCU and learn exact argument shapes through the Pi MCP gateway, without guessing or launching desktop operations.

## Observation and evidence

After a successful `mcp({connect:"native-computer-use"})`, calling `mcp({describe:"native_computer_use_computer_observe"})` returned a useful tool description and display/max_dimension annotations, but represented the optional crop as:

```text
crop - Optional region in the original capture's physical pixels, before resizing.
  anyOf:
    - schema
    - null
```

The agent cannot learn the crop object's fields from this descriptor. No crop call or desktop operation was attempted.

A separate synthetic schema probe against the repository adapter confirmed the same rendering for a nullable `$ref` whose `$defs` contained x/y/width/height. A second probe with a described integer timeout (millisecond units, bounds, default, and zero semantics) returned only `{ timeout: number; }` through both gateway describe and script describe.

This is confirmed adapter presentation loss, not an NCU wire-schema or capture defect: `packages/pi-mcp-adapter/ts-shape.ts` discards field descriptions and numeric constraints when rendering succeeds; `tool-metadata.ts` does not resolve `$ref`/`$defs` when rendering falls back. Gateway `proxy-modes.ts:452` and script `mcp-code.ts:226` choose those lossy presentations.

## Environment

Installed `@nklisch/pi-mcp-adapter@2.21.0-nklisch.3`; repository commit `f20529d59261922c015c6dd3e767dc8c4ffc6ae8`. NCU package version was not independently rechecked in this evaluation. No screenshots, clipboard data, or desktop state were collected.

## Suggested direction

Keep compact overview shapes, but provide an exact schema retrieval path that preserves definitions and meaningful annotations. Prefer one consistent descriptor contract across gateway and scripts. Upstream commit `7d69db2` adds script input guidance/output schemas but does not fully resolve the gateway/ref fallback problem. This report does not authorize an NCU implementation change.

## Additional Voxlar workflow evidence

During portal gameplay verification on 2026-09-06, the same gateway described
`native_computer_use_computer_act` with only `action *required*`, omitting the
referenced gesture variants and their fields. The agent needed a bounded
physical-key hold but could not discover `keycodes` and `duration_ms` there.
Reading NCU's README and `src/types.rs::InputAction` supplied the exact shape.
The observe crop description also retained the `anyOf: schema / null` form;
using x/y/width/height from the returned observation metadata successfully
produced a cropped observation. Capture itself worked. No input failure or NCU
wire-schema defect is claimed, and no unrelated screen content is retained in
this report. Installed adapter version was not rechecked in this additional run.

## NCU feedback assessment, 2026-09-06

The owning Pi worktree already contains exact-schema/discovery corrections under
`/home/nathan/dev/pi-extensions/.work/active/mcp-agent-reliability.md`. Its source
was dirty and independently owned during this assessment; this NCU change does
not duplicate, install, or declare that work complete. The installed adapter was
`2.21.0-nklisch.3` at assessment. Remaining qualification belongs to that owner:
actual NCU crop/action schemas through gateway and script describe, cold configured
server discovery, packed Plugin Host composition, and a fresh installed Pi process.

Additional evidence: `mcp({describe:"native_computer_use_computer_act"})` also rendered `action *required*` without the tagged action alternatives. NCU0.2.0's `src/types.rs::InputAction` supplied the actual `keypress`/`hold` schemas for the owned-desktop gameplay check. This confirms another missing nested schema surface, not a failed input operation.

Semaken owned-desktop continuation: `computer_act` describe still exposes only
`action *required*`. A drag using `path` was rejected before input with
`unknown field path, expected one of points, button, duration_ms, keys`.
Retrying the corrected `points` shape succeeded. Please include tagged nested
action schemas in agent-visible describe output; no NCU implementation change
was made by this consumer.

Orogen Tauri qualification, 2026-09-06: the connected gateway again exposed only `action *required*`. An attempted `type: "key"` failed before input with `unknown variant key, expected one of move, move_relative, hold, click, scroll, keypress, type, drag`; the corrected `keypress` with `keys: ["ESC"]` closed the native dialog and restored focus. A scroll with `amount` likewise failed before input, reporting the actual fields `x`, `y`, `dx`, `dy`. These are agent argument errors made harder to avoid by the missing nested descriptor, not evidence of a wire-schema defect. No unrelated desktop content was retained.

Additional consumer evidence (Semaken cold attempt 02): `computer_act` scroll
with `{type:"scroll",at:{x:1340,y:810},dy:622,dx:0}` was rejected with
`unknown field at, expected one of x, y, dx, dy`. Corrected flat x/y parameters
were accepted. Nested action alternatives remain important in discovery so a
consumer does not infer scroll targeting from the different `type` action.

Further same-schema friction during native Ky chooser navigation: click variant
accepted `count: 2`, not guessed `click_count: 2`. The rejected request named
`unknown field click_count, expected one of x, y, button, count`; no input was
sent. Correcting to `count` entered the folder successfully. This is agent
argument error made harder to avoid by the undisclosed nested action schema,
not a confirmed click implementation defect.


## Relocation context

At relocation, `.work/releases/mcp-agent-reliability.md` records the exact-schema correction published in adapter `2.21.0-nklisch.4`. The observations below were made against older or unverified loaded versions. Preserve this as consumer qualification evidence, not proof that the published correction failed. The report's former active-item pointer is historical; the release record is the current pointer.
