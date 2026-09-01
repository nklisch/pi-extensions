---
release: subagent-query-recovery-2026-09-01
date: 2026-09-01
packages:
  - "@nklisch/pi-subagents@18.2.0-nklisch.1"
  - "@nklisch/pi-plugins@0.8.1"
  - "@nklisch/pi-enhanced@0.3.1"
items:
  - feature-subagent-query-recovery
---

# Complete long-transcript query recovery

## Pi Subagents 18.2.0-nklisch.1

`query_subagent_session` now searches complete message text, tool arguments, tool names, call ids, and correlated results. Returned preview limits no longer cause false negatives for phrases appearing later in a long response.

Non-empty queries return bounded context around the first matching passage, including the matched field and source range. Successful transcript reads explicitly report complete-search semantics; prefix previews remain available for empty-query browsing.

Stateless `offset` pagination composes with kind, order, and limit. Results expose total and returned counts, omissions before and after the page, and copyable next/previous offsets. A page beyond a non-empty result set is distinct from a query with no matches. Byte and line bounds shorten pages without skipping entries, and every matching page makes forward progress even for newline-dense content or pathological tool metadata.

## Pi Plugins 0.8.1 and Pi Enhanced 0.3.1

Pi Plugins rebundles the corrected Pi Subagents query surface. Pi Enhanced rebundles Pi Plugins so bundled installations receive the fix.

## Verification

- Regression coverage searches distinct phrases beyond the former 8,192-character prefix in live and persisted message, argument, and result fields.
- Focused query/model/tool/overlay tests passed.
- `@nklisch/pi-subagents`: 957 tests across 82 files, typecheck, declaration build, and packed public-type verification passed.
- The Pi Plugins compiled production consumer contract and typecheck passed.
- Repository `npm run check` passed before and after synchronized versioning.
- The standard-weight Sol review found three material issues; all were accepted and corrected without a second formal pass: zero-progress bounded pages, unbounded tool metadata presentation, and incomplete persisted-result regression evidence.

## Publication receipts

Trusted-publishing workflow [run 33561045174](https://github.com/nklisch/pi-extensions/actions/runs/33561045174) succeeded from commit `8a5654898bc44d9e35a84e5271bc75a48309ecea`.

- `@nklisch/pi-subagents@18.2.0-nklisch.1` — `sha512-lb69chb7fsGFQLC+HjwWpz4yYhUxyzG0Pr9L1itQRKVRbLBIHR6Wmdt4Irt8/KdvVFq5BxTnLoJRbiRwyE8NIQ==`
- `@nklisch/pi-plugins@0.8.1` — `sha512-hqn0sR5ZiLp7wmlDzO0MmSicUFVwfQ4OBIRjb7RBoKfy5pjICIEHBK8bhB0IZ7Br0xQdsUdckodtLeWeto+SuQ==`
- `@nklisch/pi-enhanced@0.3.1` — `sha512-sMY9M+wp3WajjqIqMlb3BILr8nwsKOsOlHz7cL/E76ksnaAjNV264qIa8z7Su10+RxbiOL3PZzsFAjxnt3n2kg==`
