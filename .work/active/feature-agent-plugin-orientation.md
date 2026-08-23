---
id: feature-agent-plugin-orientation
kind: feature
status: active
tags: [ux, agents]
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
created: 2026-08-22
updated: 2026-08-22
---

# Agent orientation to the installed plugin set

> Workbench version mismatch: stop and offer setup upgrade.

## Outcome

Agents in pi sessions get a short, generated orientation to the plugin
system: which plugins are installed, each one's version and marketplace
origin, and what components each provides (skills with one-line
descriptions, MCP servers, hooks where relevant) — plus degraded/backup
status. An agent can then answer "what plugins do I have", know that a
plugin requires a version stamp (e.g. workbench), and know that an MCP tool
or skill should exist because plugin X provides it.

## Settled requirements (user, 2026-08-22)

- **Short and sweet**: orientation, not documentation. Generated from live
  state, version-locked to the installed pi-plugins; no hand-maintained
  prose, no ARCHITECTURE/SPEC depth.
- **Two surfaces**: (a) 2-3 lines injected as session context at session
  start carrying AGENT-relevant facts only — installed set, versions,
  marketplaces, component availability, degraded status; (b) a generated
  brief file with the per-plugin detail.
- **No user-facing commands in the injected line** (no "Manage: /plugins
  …"). The brief file MAY include a user-facing command section (/plugins
  list, doctor, updates, repair, rollback) but must mark it explicitly as
  user-facing explanation so the agent relays it to help the user rather
  than treating the commands as agent tools.

## Boundary

In scope: session-start injection via the host's extension, brief generation
from live host state, refresh after lifecycle mutations, tests. Out of
scope: changes to pi itself, plugin-authored skill content, deep reference
docs.

## Closure evidence

- A fresh pi session's agent context contains the injected orientation with
  correct plugin/version/marketplace facts and no user-facing commands.
- The brief file exists, is current after an install/update/disable, marks
  the user-facing section, and stays within a small size budget.


---

## Design review adjudication (2026-08-22, gpt-5.6-sol, standard weight)

Verdict: revise — four material findings, all accepted and folded in:

1. **Dedup against active context**: injection dedup reads pi's
   `buildContextEntries()` (active branch, compaction applied), not the raw
   transcript `getEntries()` — an orientation lost to compaction or branch
   navigation must be re-injected, not suppressed.
2. **Project-scoped brief identity**: the brief path is scope-aware (user
   brief plus project-keyed briefs), with an authoritative state-generation
   recheck before write; no new lock machinery.
3. **Freshness from authoritative state, not runtime epoch**: the installed
   inventory is built from authoritative user/project state (runtime
   selections only annotate what is active); refresh is keyed on state
   generation / mutation outcome; after admitted foreground mutations the
   best-effort refresh is awaited (errors swallowed) so "current after
   mutation" has a completion boundary. This replaces the epoch check, which
   was both wrong and overbuilt.
4. **Stale brief on failed startup**: when state is unreadable, the brief is
   atomically replaced with a short "orientation unavailable this session"
   marker (never blocking), not left stale.

Minor notes accepted: pointer line simplified to "Per-plugin component
detail: <path>" (no mention of user commands in the injection); the
generator/package version participates in the dedup digest; description
lengths capped with deterministic omission (the elaborate 32 KiB truncation
policy is dropped; inventory count always complete); brief commands labeled
as command families, not literal syntax. Mechanism verdict stands:
`pi.sendMessage(display:false, triggerTurn:false)` is the right primitive;
its async failures are internally caught by pi, which still satisfies
degrade-don't-refuse.

# Design: `feature-agent-plugin-orientation`

## Outcome and constraints

Agents in pi sessions get a short, generated orientation to the installed plugin
set: which plugins are installed, versions, marketplace origins, component
availability, degraded status — via two surfaces: (a) 2–3 injected session-context
lines at session start carrying agent-relevant facts only, and (b) a generated
brief file with per-plugin detail, whose user-facing command section is
explicitly marked as user-facing explanation. Generated from live host state,
version-locked to the installed pi-plugins (the generator ships inside the
package; no hand-maintained prose). Out of scope: changes to pi itself,
plugin-authored content, reference docs.

Constraints that shaped the design:

- pi-plugins is a **native pi extension** (`packages/pi-plugins/src/pi/extension.ts:11-33`),
  not a foreign plugin — the workbench SessionStart command-hook pattern
  (`.payload-c990…/hooks/hooks.json`) is the *foreign* plugin path; the hook
  adapter here would be running our own extension through a compatibility shim
  it exists to provide to others. Wrong layer.
- Ports-and-adapters (`packages/pi-plugins/docs/ARCHITECTURE.md`, "Architectural
  principles"): content assembly must be pure and testable; only a thin pi
  adapter touches `ExtensionAPI`.
- Failure semantics (`docs/PRINCIPLES.md`, "Fail-closed guards must defend
  against a real threat"): generation must degrade, never block or refuse.
- Workbench plugin version matches conventions (loaded `plugin.json` =
  `workbench 0.10.0` = `.work/CONVENTIONS.md` `workbench_version: 0.10.0`); no
  setup upgrade needed before this work.

## Chosen approach

### A. Injection mechanism and payload

**Mechanism — native `pi.sendMessage()` from the `session_start` path.**
Pi's ExtensionAPI has no SessionStart-hook additionalContext contract for
native extensions; the documented injection primitive is
`pi.sendMessage()`: "Custom messages participate in LLM context"
(pi `docs/extensions.md:1389-1391`), persisted as a `CustomMessageEntry` whose
"content is converted to a user message in buildSessionContext()" with
`display: false` meaning "hidden entirely" in the TUI
(`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:85-102`).
The `details` field is "extension-specific metadata (not sent to LLM)" — used
here to carry a facts digest for dedup. Precedent inside this package:
`pi-command-hook-runtime.ts:194` already delivers hook outcomes via
`sendMessage`, and `pi-update-notification-publisher.ts:40,80` already uses the
`appendEntry`/`getEntries()` transcript-scan pattern for exactly this
once-per-fact dedup problem.

**Wire point:** the sessionStart target in
`src/composition/create-packaged-plugin-host.ts:829-835` currently does
`await start(event, context)` then dispatches delegates. The orientation
publisher is invoked there, *after* `start()` settles — in a `try/catch` that
never throws, for both success and failure of startup. Pi awaits extension
`session_start` handlers during startup, so facts are accurate without adding
meaningful delay; injection itself is microseconds.

**Dedup:** before injecting, scan `context.sessionManager.getEntries()` for the
orientation `customType`; skip when the newest existing orientation message's
`details.factsDigest` equals the current digest; inject fresh when absent or
changed. This handles `reason: "resume"` (same facts → no duplicate in a
long-lived session file) and `reason: "reload"` after a mutation (changed facts
→ the agent learns the new state mid-session). Inject on **all** session_start
reasons (`startup | reload | new | resume | fork` — pi
`core/extensions/types.d.ts`, `SessionStartEvent`).

**Payload template (2–3 lines, ≤ ~90 tokens, agent facts only):**

```
Plugins: 3 installed (pi-plugin-host) — workbench@workbench 0.10.0 (6 skills, 1 hook), krometrail@krometrail-market 1.2.0 (1 MCP server); disabled: peer@nklisch.
Degraded: krometrail@krometrail-market (MCP_ADAPTER_UNAVAILABLE — running previous revision).
Per-plugin detail (components, skill one-liners, user commands): ~/.pi/agent/plugin-host/generated/agent-brief.md — regenerated at session start and after plugin changes.
```

- Line 1: installed set — `name@marketplace <version>` where version is
  `declaredVersion` from revision source evidence
  (`src/domain/state/installed-state.ts:111`) falling back to a 8-char revision
  digest; component counts from the `RuntimeSelection`
  (`src/composition/runtime-selection-catalog.ts:23-37`: skillHook/hooks/mcp).
  Cap at 6 plugins then `+N more (see brief)`. Disabled plugins listed by name
  only (activation intent from `InstalledPluginRecord.activation`,
  `installed-state.ts:190-194`).
- Line 2 (only when non-empty): degraded entries from the runtime
  reconstruction degraded list (`src/composition/runtime-desired-state.ts:52-56`,
  published in `HostStartupResult.blocked`,
  `src/application/host-observation-contract.ts:26-46`) — `name (CODE — short
  explanation)`.
- Line 3: brief pointer. **No user-facing commands anywhere in the injected
  lines** (settled requirement).

**Host degraded/not ready:** if `start()` rejected (state unreadable, corrupt),
inject exactly one line instead:

```
Plugins: pi-plugin-host state is unavailable this session (<stable error code>); plugin-provided skills/MCP tools may be missing.
```

No brief pointer (no brief is written — see D), no enumeration. This is the
degraded path, not a refusal: skills/MCP availability itself is already governed
by the existing degraded/fallback machinery.

### B. Brief file

**Location: `<hostRoot>/generated/agent-brief.md`** where
`hostRoot = join(agentDir, "plugin-host")`
(`src/composition/plugin-host-paths.ts:33-34`). Validated against the host's
`generated/` conventions: runtime *projections* live under `generated/v1/` with
sealing/READY-marker discipline, and convergence manages only its own roots
there (e.g. `generated/v1/.staging`,
`src/infrastructure/state/lifecycle-convergence-migration.ts:350`) — a sibling
informational file directly under `generated/` is outside that machinery and
fits the name ("derived, replaceable, never an independent source of truth").
Applying projection sealing to a markdown file would be ceremony; rejected.
Writer creates the directory if absent and writes atomically (temp + rename in
the same directory), best-effort.

**Format** — header, per-plugin blocks in deterministic order (user scope, then
project scope; name-sorted within scope), footer:

```markdown
<!-- Generated by pi-plugin-host <package version> at session start. Do not edit. -->
# Installed plugins (user + current project scope)

## workbench@workbench — 0.10.0 · enabled · active
scope: user · marketplace: workbench · revision: sha256:ab12cd34…
skills (6):
- workbench — Requirements-first delivery with semantic autonomy…  ← one-liner from SKILL.md frontmatter
hooks (1): SessionStart
mcp servers (0)

## krometrail@krometrail-market — 1.2.0 · enabled · DEGRADED
status: MCP_ADAPTER_UNAVAILABLE — running previous revision; repair/rollback available
mcp servers (1): krometrail
…

## For the human user — not agent tools
The slash commands below are typed by the user in the pi TUI. When the user
asks how to manage plugins, relay these; they are not callable by you.
- /plugins — open the plugin manager
- /plugins list · /plugins doctor · /plugins status — inspect installed set and health
- /plugins add|update|enable|disable|remove|repair|rollback <plugin> — lifecycle actions
```

- Facts per block: version (`declaredVersion` or revision digest), activation
  intent, active/degraded state, scope, marketplace name, revision digest,
  component counts; skills with one-line descriptions parsed from each enabled
  skill's `SKILL.md` frontmatter via the existing bounded reader
  (`src/formats/agent-skills/frontmatter-reader.ts:370`; description schema at
  `skill-reader.ts:42`) read against the resolved immutable revision content
  root; hooks summarized by event name; MCP servers by native key.
- **User-facing command section wording** is fixed and explicit ("For the human
  user — not agent tools … they are not callable by you"), and the vocabulary
  matches the actual registry (`src/application/native-control-registry.ts:270-290`:
  list, doctor/diagnose, add/install, enable, disable, update, remove/uninstall,
  rollback, repair, status).
- **Size budget: 32 KiB hard cap.** Truncation policy: the one-line-per-plugin
  inventory is never truncated; per-plugin component detail is capped first
  (≤ 10 skills listed per plugin, then `+N more skills`), and if still over
  budget, component detail sections are dropped for plugins in deterministic
  order with a footer `component detail omitted for N plugins — inventory above
  is complete; use /plugins show` — no wait, the brief MAY contain user
  commands; the footer may reference the user-facing section. Typical installs
  (< 20 plugins) will never hit the cap.

### C. Refresh triggers

1. **Session start, all reasons** — after `start()` settles: regenerate the
   brief and evaluate the injection (dedup by facts digest). This alone covers
   cross-process mutations (SQLite CAS from another pi session) and automatic
   updates applied earlier: committed automatic updates end in best-effort
   reload or `live-next-start`; a reload re-fires `session_start` with
   `reason: "reload"` (pi docs `extensions.md:374,398,1276-1278`).
2. **After admitted foreground operations** — in the completion path of
   `runWithPiOperationContext`
   (`src/composition/create-packaged-plugin-host.ts:797-825`), which already
   exists as the settle point for operations that "may settle installed state":
   if the runtime selection epoch (or degraded set) changed during the
   operation, schedule a detached best-effort brief regeneration — same posture
   as the existing `wakeBackground()` there. This makes the brief current
   immediately after `live-next-start` mutations that don't reload
   (closure evidence requires current-after install/update/disable).

Rejected alternatives (one line each): a state-generation watcher — the
`LifecycleStateStore` port is read/commit only and has no watch surface;
building one is new machinery for marginal gain. Regeneration on read — there
is no read hook for a plain file the agent opens. Re-injecting the full
orientation after every mutation — noise; the brief is the mutable surface and
the mutation result is already user-visible in `/plugins`.

### D. Failure semantics

- Orientation generation and delivery are wrapped so they **never throw and
  never block startup**: the publisher runs after `start()` settles, catches
  everything (matching the existing detached-work posture,
  `create-packaged-plugin-host.ts:714-716`), and a failed `sendMessage` or brief
  write is silent loss of an informational surface — exactly the degraded path
  PRINCIPLES requires.
- **State unreadable**: inject the single failure line (A) naming the stable
  error code; do not write a brief (an error-stamped brief risks being read as
  orientation; absent file + explanatory line is honest). No new guard, no
  refusal: plugin activation itself is already governed by existing
  degraded/fallback handling.
- Skill frontmatter read failure for one skill: omit that one-liner (`(description
  unavailable)`), keep the block. Brief over budget: truncate per policy, never
  fail.

### E. Layering

Pure content assembly lives in `src/application/` (no Pi imports); fact
collection uses existing ports (selection catalog snapshot, startup/desired
state, resolved content roots); delivery (`sendMessage`, `getEntries`, file
write) lives in a thin `src/pi/` adapter wired at the sessionStart target.

## Alternatives

- **SessionStart command hook (workbench pattern)** — rejected: that is the
  foreign-plugin path; pi-plugins is a native extension and would be tunneling
  its own context through the compatibility adapter it provides to third
  parties. `sendMessage` is the native equivalent of `additionalContext`.
- **`before_agent_start` message injection / `context` event mutation** —
  rejected: per-turn events requiring once-gating state; `sendMessage` at
  session_start is one call with built-in persistence and dedup via transcript
  scan.
- **Contributing the brief as a pi context file / `resources_discover`
  promptPath** — rejected: pi has no extension API for context files (only
  skills/prompts/themes in `ResourcesDiscoverResult`); prompt templates are
  user-invoked, not auto-injected. The brief is read on demand because the
  injected line points at it.
- **`pi.sendUserMessage()`** — rejected: forges a user turn; custom messages
  are the documented extension-injection channel.
- **Projection-grade sealing for the brief (READY marker, read-only)** —
  rejected as ceremony: the brief is informational, not an activation surface.

## Implementation units

1. **Orientation content module** (`src/application/agent-orientation.ts`):
   input = plain snapshot (selections with versions/markets/component counts,
   activation intents, degraded entries, skill name→one-liner map, host
   version, brief path); output = `{ injectionLines, degradedInjectionLine?,
   briefMarkdown, factsDigest }`. Pure, no I/O.
2. **Fact collection** (`src/composition/` wiring + a small filesystem-facing
   reader): selection catalog snapshot → versions/markets/counts; startup
   result / desired state → degraded list; `readBoundedFrontmatter` against
   resolved revision roots → skill one-liners.
3. **Pi delivery adapter** (`src/pi/agent-orientation-publisher.ts`):
   `sendMessage` with `customType: "plugin-host:agent-orientation-v1"`,
   `display: false`, `triggerTurn: false`, `details: { factsDigest }`;
   transcript-scan dedup; never throws. Wired in the sessionStart target.
4. **Brief writer + refresh hook**: atomic write under
   `<hostRoot>/generated/`; epoch/degraded-change check after admitted
   operations with detached regeneration.

Deliverable as one coherent commit-sized feature; units 1–2 are the bulk, 3–4
are thin.

## Verification (contract-level tests)

- **Injection content vs fixture host state**: fixture selections + degraded
  entries → exact expected lines (version, marketplace, counts, degraded,
  pointer); **invariant: no user-facing command (no `/plugins`) appears in the
  injected content**.
- **Brief generation**: fixture state + fixture SKILL.md files → brief with
  per-plugin blocks, skill one-liners, degraded marking, deterministic order.
- **User-facing-section marking**: header present with the fixed wording; and
  the invariant that every `/plugins…` token in the brief occurs only inside
  that section.
- **Dedup**: fake transcript with same digest → no send; different digest →
  one send; empty transcript → one send (fake pi with recorded `sendMessage`,
  existing `test/pi` fake-API pattern).
- **Failure path**: unreadable state → failure line sent, no brief file, no
  thrown error.
- **Refresh**: epoch change after operation → brief regenerated (e.g. plugin
  disabled → absent/disabled-marked in regenerated brief).
- **Size/truncation**: oversized fixture → brief ≤ 32 KiB with complete
  inventory and omission footer.

Closure evidence beyond unit tests: the existing e2e suite already boots real
pi with the production fixture; an optional assertion there can confirm a fresh
session's context contains the orientation message (park as follow-up if it
adds suite cost).

## Risks

- **Token weight of injected lines grows with plugin count** — mitigated by the
  6-plugin cap + `+N more`; digest-dedup prevents accumulation across resumes.
- **Brief staleness window**: mutations made by *another* pi process between
  this session's start and next refresh leave the brief stale until next
  session start/reload; the brief header states regeneration timing, and the
  injected line says "regenerated at session start". Accepted (single-user
  tool, SQLite CAS already serializes state).
- **Unrendered `display:false` custom messages in third-party transcript
  tooling** — content is plain text; no renderer registration needed (pi hides
  display:false entries in its TUI).
- **`declaredVersion` absent** (older records) — falls back to revision digest;
  the outcome's "version stamp" expectation degrades gracefully rather than
  refusing.

## Non-blocking follow-ups (parked, not built)

- e2e assertion that a real pi session transcript contains the orientation
  custom message.
- A one-line delta custom message when the facts digest changes mid-session
  without reload (currently only the brief updates silently).
- Surfacing update-availability ("workbench 0.10.1 available") in the brief —
  adjacent to orientation, explicitly out of the settled requirements.