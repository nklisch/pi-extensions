---
id: mcp-structured-result-delivery
kind: feature
status: active
tags: [mcp, reliability]
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
created: 2026-09-05
updated: 2026-09-05
---

# Preserve structured MCP results in model-visible delivery

## Outcome

An MCP result with summary text, an image, or a resource link must not lose its distinct structured facts before reaching the model. Ordinary, direct, programmatic, and error tool paths should deliver those facts within the existing bounded-output contract, with explicit and usable recovery for omitted output. Scripting must not silently present a bounded summary as complete canonical data.

The user explicitly authorized fixing this defect in `../pi-extensions` while Krometrail reliability work continues. A diagnostic against installed `@nklisch/pi-mcp-adapter` 2.21.0-nklisch.2 reproduced six structured-fact losses through its actual compiled result projector and output guard. The source package is the same version. The diagnosis and synthetic fixture are retained in [Krometrail's result-delivery item](https://github.com/nklisch/krometrail/blob/main/.work/active/features/epic-a-grade-reliability-agent-result-delivery.md). This does not establish the cause of the historical screenshot-selection incident or qualify other native clients.

## Scope and constraints

- Own generic MCP result presentation in `packages/pi-mcp-adapter`, affected shared call sites, regression/contract tests, and essential package documentation.
- Preserve server outcome, current result authority, native image/resource handling, bounded output, source lifecycle, privacy, and actual error status. Presentation failure must not replay an action or claim its dispatch failed.
- Reuse existing output limits and spill ownership where they meet the need. Keep full data recoverable under pressure, or explicitly state why recovery is unavailable. Do not add a second transport, browser-specific projection, cache/registry, new configuration surface, or semantic guesses about server data.
- No changes to Krometrail acquisition/selection/freshness, unrelated packages, the user's existing lockfile/Ollama changes, credentials, installed extensions, production configuration, or retained user data.
- No publication, package-version release workflow, or installation update is authorized by this source fix. If version/pin updates are required for source acceptance, coordinate them as one coherent change; do not independently publish siblings.

## Acceptance evidence

- The installed-loss fixture has equivalent source-level regressions that fail before the fix and pass after it; exercise real call paths and provider-input construction without sending a model request.
- Structured plus summary/image/resource results retain all under-budget facts; exact already-delivered structured JSON is not needlessly repeated; text-only and structured-only results retain their meanings.
- Success, degraded results, errors/diagnostics, and scripted calls do not lose structured identities or misrepresent outcome/completeness.
- Boundary cases cover byte/line/details limits, multibyte text, large structures, explicit omissions, readable spill references, and spill-write failure without native-image base64 expanding into text.
- Package tests/build/pack checks and root `npm run check` pass, or a concrete unrelated blocker is reported without weakening tests.
- Reconcile affected durable documentation and the knowledge index if changed. Formal design and one balanced integrated implementation review precede closure.

## Execution posture

Adaptive autonomy and execution; balanced simplification; standard review weight. There is no project overbuilding-calibration section, so current code and the local-tool threat model govern proportionality. The user's current model assignments override the repository's stored model defaults for this feature: Astra medium for complex cross-cutting design/integration, Flash xhigh for scoped implementation, Astra review. Astra low remains appropriate for medium-complexity implementation. This is not a conventions migration.

The isolated worktree starts from the source repository's committed HEAD; its unrelated modified `package-lock.json` and untracked Ollama work remain untouched. Heavy installs/builds/tests share `/tmp/krometrail-reliability-build.lock` with the other active workers. The parent owns integration and final closure. Design is the next checkpoint; no production patch has been selected yet.

## Accepted design and parent review — 2026-09-05

Astra medium completed a read-only source design pass. The parent independently inspected the existing resolver, output guard/spill writer, scripting consumer, and package ownership policy, and accepts the following scoped design for implementation:

1. Extend `tool-registrar.ts`'s existing resolver to preserve native transformed content and append distinct serialized structured content, including empty objects. Suppress the addition only when a whole existing text block represents the same JSON value; do not deduplicate prose, substrings, or partial objects. Serialization failure must produce an explicit presentation-unavailable notice, not an action failure.
2. Route successful and failed proxy/direct/programmatic results through that resolver, preserving error prefixes, schema guidance, UI handoff, outcome metadata, and existing error signaling.
3. Apply the existing aggregate text guard after resolution. When both text and raw-details overflow, reuse the guard-owned full MCP-result spill instead of duplicating it as a text spill. Clearly label the recovery artifact's actual format. Text-only call sites retain full-text recovery. Preserve native images, private file permissions, and explicit unavailable-recovery notices on write failure.
4. Give `executeCall()` a narrow internal call-local capture seam for the decoded SDK result. Successful scripts return that acquired result in the existing `{ ok: true, data }` shape, never a persisted-details summary. Preserve existing failure envelopes and guard final script emissions. No cache, reread, extra transport, or action replay.

Owned code: `tool-registrar.ts`, `mcp-output-guard.ts`, `proxy-modes.ts`, `direct-tools.ts`, `programmatic-extension.ts`, and `mcp-code.ts`, plus affected existing tests/fixtures and essential package README/scripting guidance. `error-signal.ts`, package versions/pins, lockfiles, and sibling packages remain unchanged absent a demonstrated need returned to the parent.

### Review qualifications

- Existing limits bound model context and persisted details, not acquisition or peak serialization memory. A streaming serializer would add unsupported scope. Existing tiny configured budgets can be smaller than their own recovery notice; retain honest accounting and do not claim a newly strict absolute ceiling.
- Spill reuse must rely on guard-owned metadata, not server-provided fields such as `omitted` or `fullResultPath`. The SDK result remains the sole data authority.
- Verify that the shared spill actually contains all canonical facts, that references are model-visible, and that recovery instructions fit its format. Do not advertise line-offset access to otherwise inaccessible portions of a compact single-line JSON result. JSON-aware bounded extraction or suitably readable formatting may reuse the existing artifact; no second recovery service is needed.
- Presentation failures must not change a proven dispatch into a retriable action failure. Preserve `toolErrorOverride()` and ordinary error classification. No server result field becomes adapter control metadata.
- Use actual provider-input construction with network dispatch captured/stubbed, not terminal rendering or assertions only against details. No model request or browser is required for adapter-level acceptance.

Implementation is ready at this boundary. Standard independent implementation review remains required after focused regressions and project gates. Parent owns final integration and closure.

## Review corrections — Astra independent review of 81e5fe7..e63a5e7, 2026-09-05

All four review findings accepted and addressed; architecture (shared resolver, call-local capture, guard-owned spill metadata, unchanged error envelopes) unchanged:

1. **Affix loss on raw-spill reuse (required).** The guard reused the raw-JSON spill as the sole recovery artifact whenever both budgets overflowed, but adapter affixes (error prefixes, `Expected parameters:` schema guidance, UI handoff) exist only in the composed text — a reviewer probe lost a schema canary from both the preview and the saved artifact. The reuse is now affix-aware: raw-spill reuse happens only when `prefix`/`suffix` are empty (composed text fully contained in the raw result); affixed overflow keeps the composed-text spill for guidance recovery alongside the raw details spill, and the notice points at the artifact that actually holds the recoverable content. A text-spill write failure with an existing raw spill says so explicitly. Regressions: affixed overflow keeps the canary in the saved text artifact through real stdio proxy and direct callsites; UI-handoff overflow keeps the suppressed-window message and viewer URL recoverable through the real `executeCall` UI branch; write-failure notice stays explicit.
2. **Untruthful line-paging promise on JSON spills (required).** Pretty-printing splits structure onto lines but long string VALUES remain single lines that read tools refuse (`Line is … exceeds 50KB limit`). The raw-JSON reuse notice now directs JSON-aware local extraction (grep for keys; `node -e` with JSON.parse to select fields or slice long strings) and explicitly says not to rely on read line paging. The text-spill notice measures the actual longest line and, above ~50 KB, says grep-only with the long-line caveat. A regression proves bounded recovery of a sentinel fact and a bounded slice of a 120,000-char string from the actual shared spill, with image base64 never entering model text.
3. **`isDeepStrictEqual` stack exhaustion (required).** SDK-decodable depth-2000 JSON overflowed the recursive comparator; the caught error was treated as inequality and an ~8 MB duplicate was appended. The whole-block comparison now uses a small iterative (explicit-worklist) JSON-value comparison — depth-tolerant, key-order independent, failure-to-compare treated as not-established inequality rather than difference. No depth refusal, no peak-memory claim, no serializer framework. Regressions: depth-2000 same-value dedupe (fails at e63a5e7), depth-2000 distinct-value single append, reordered deep keys dedupe.
4. **Provider-evidence overstatement (evidence).** `convertToLlm` passes toolResult messages through unchanged, so the original captures proved message-level delivery only. Renamed and reworded accordingly, and added offline provider-request construction using the actual pinned `@earendil-works/pi-ai` 0.82.0 `anthropic-messages` provider: the built request payload is captured via the provider's own `onPayload` seam with a fixture API key, an already-aborted signal, and a dead loopback `baseUrl` (127.0.0.1:9) — no network request, no real credentials. Assertions cover the `tool_result` block (`is_error` semantics, structured sentinels, summary text) and the native base64 image source with no base64 in text. Installed Pi 0.85.1, native Claude/Codex clients, Rust MCP servers, and live providers remain unqualified by this evidence.

### Correction gate receipts

Recorded against the correction commit, all under the shared reliability lock with captured exit markers: typecheck clean; focused suites (7 files) 111/111; before/after proof — with the two corrected sources checked out at e63a5e7 (scratch-copy restore, checksum-verified), 6 new-regression tests fail (`retains the composed-text spill when affixes add information`, `keeps truthful instructions for text spills with unpagedable lines`, `compares deeply nested values without stack exhaustion`, `keeps oversized UI-handoff guidance recoverable through the text spill`, `keeps oversized schema guidance recoverable through the proxy path`, and the raw-spill truthful-notice case) and all pass after restore; full package suite 1040/1040 (TEST_EXIT=0), build BUILD_EXIT=0, `test:package` TESTPKG_EXIT=0, `npm pack --dry-run` PACK_EXIT=0, root `npm run check` ROOT_CHECK_EXIT=0 with zero npm errors and no unrelated blockers (pi-clearance 2755, pi-plugins 957, pi-subagents 476, adapter 1040, plus root script suites).

## Existing workflow-validation limitation

The installed Workbench 0.19.0 validator reports the same three errors both with and without this new item: superseded `.work/archive`, noncanonical `.work/archive`, and missing id in `.work/completed/subagent-session-lifecycle-and-resume.md`. Project stamp is 0.10.1. Baseline was checked with the new item temporarily excluded and restored. No workflow migration or unrelated stub edits are authorized. This is not an adapter test failure; retain the limitation rather than claiming a clean ledger validation or silently migrating it.

## Implementation evidence — Flash xhigh, 2026-09-05 (pending parent review)

Delivered on branch `work/mcp-structured-result-delivery` per the accepted design, no design deviations:

1. `tool-registrar.ts` — `resolveMcpResultContent` now appends `structuredContent` as a distinct labeled text block when content blocks exist (empty objects included). Suppression only when a whole existing text block parses as JSON deeply equal to the value (`node:util` `isDeepStrictEqual`); prose, substrings, partial objects, and key-order-only differences are handled correctly. Serialization failure appends an explicit presentation-unavailable notice; the call never throws. Empty-content fallback behavior is unchanged.
2. `proxy-modes.ts` / `direct-tools.ts` — both error branches now route through the shared resolver (previously raw `transformMcpContent`, bypassing structured facts); success paths unchanged in shape. Error prefixes, schema suffixes, UI handoff, `toolErrorOverride` codes, and details shapes preserved. Direct tools still carry no `details.mcpResult`.
3. `mcp-output-guard.ts` — the raw details result is bounded before the text branch. The oversized spill is now readable (pretty-printed) JSON holding the complete result; `rawResultBytes` still reports the compact measurement used for the details budget. When text and details both overflow, the guard-owned result spill is the single recovery artifact: no second text spill is written and the notice references `Full MCP result (JSON) saved to: <path>`. Without a result spill (no raw result, budget not exceeded, spill write failure), text-only call sites keep the full-text spill; a failed result-spill write falls back to the text spill and both write errors are reported. No server field influences any of this. Native images, 0600 temp files, affixes, kill switch, and `enabled: false` passthrough are unchanged. Limits still bound model context and persisted details, not acquisition or peak serialization memory.
4. `mcp-code.ts` — `callTool` passes a call-local capture callback through a new optional `executeCall` seam (`captureDecodedResult`, exported `ClientCallToolResult` type). Successful script calls return the acquired decoded SDK result in the existing `{ ok: true, data }` shape, never the persisted summary; failure envelopes unchanged; no cache, reread, replay, or transport added. `programmatic-extension.ts` needed no edit — it already routes through the shared resolver and inherits the fix.

Regression evidence (vitest, package suites, 92 tests): against the stashed pre-fix source, 25 tests fail; with the fix, all pass. Failing-before list includes: resolver append cases (content+structured, images, resource links, empty object, non-dedupe of prose/partial), error-branch delivery through real proxy/direct/programmatic paths, message-level provider delivery captures via `convertToLlm` (success, error `isError: true`, oversized bounded + native image outside text), script data beyond the details budget returning the decoded result, spill-reuse and readable-spill cases, output-schema valid-path structured delivery, and the honest tiny-budget accounting. Boundary cases covered: multibyte byte-boundary truncation without U+FFFD, details-only overflow, exact-duplicate suppression (compact/pretty/key-reordered), shared-spill recovery references, spill write failure (locked TMPDIR, env restored), empty/text-only/structured-only results. `convertToLlm` passes toolResult messages through unchanged: these are message-level delivery captures, not provider-request construction; offline provider-request construction evidence was added after independent review (see correction section).

No foundation document or knowledge-index assertions became stale; README Output Guard and scripting sections plus `skills/mcp-scripting/SKILL.md` updated in place. `programmatic-extension.ts`, `error-signal.ts`, versions, pins, and lockfiles untouched. Gates, all in this isolated worktree under the shared reliability lock: package typecheck clean; focused suites 92/92; full package suite 1029/1029 across 99 files (one earlier run failed only `programmatic-host-peer-clean` because `dist/` was not yet built in the fresh worktree — built, then green); `npm run test:package` exit 0; `npm pack --dry-run` exit 0 (194 files); root `npm run check` exit 0 with no unrelated blockers (validate, builds, all workspace suites, pack inspection). Build/install artifacts created for parent cleanup at retirement: root `node_modules/`, package `node_modules/` trees, `packages/pi-mcp-adapter/dist/`, `examples/interactive-visualizer/{node_modules,dist}` (visualizer fixtures required by the suite), and `/tmp/{mcp-adapter-*,vitest-*,root-check}.log`. Item stays active for the parent's Astra review and integration; closure, release bindings, and any publication remain parent-owned.
