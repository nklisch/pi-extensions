# Developer guide

This guide is for people changing Pi Clearance itself.

> The pre-public command surface is `/clearance`; removed commands and aliases are not preserved.

For product behavior, start with [README.md](../README.md) and [USER_GUIDE.md](USER_GUIDE.md). For design intent, read the foundation docs linked at the end of this file.

## Requirements

- Node.js 22 or newer
- pnpm 11
- Pi, when testing the extension in a real session

Install dependencies:

```bash
pnpm install
```

## Main commands

```bash
pnpm check
pnpm test
pnpm --dir . run-script lint
```

Use the scoped lint command. In some local environments, bare `pnpm lint` can be shadowed by a wrapper that is not this package's script.

## Package shape

`package.json` registers the Pi extension and thin agent skills. It ships no public
executable; the Tune workflow is Pi-native. The native engine is a prebuilt
Node-API addon, not a package-install build:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"],
    "skills": [
      "./src/skill/clearance-tune/SKILL.md",
      "./src/skill/clearance-pack-authoring/SKILL.md"
    ]
  },
  "files": ["src", "native", "README.md", "docs", "LICENSE"]
}
```

Pi loads `src/index.ts` as the extension composition root. `src/native/loader.ts`
resolves the local development artifact or the matching napi-rs optional package
(`pi-clearance-linux-x64-gnu` or `pi-clearance-darwin-arm64`). A missing
artifact refuses to arm the extension; no install script or Cargo fallback exists.
`pnpm build:native` is contributor-only. Release preparation builds both targets,
stages them with `pnpm native:prepare`, and publishes the platform packages before
the root package.

Shipped interfaces:

- extension: automatic Pi `tool_call` reviewer;
- package-registration event surface for package-contributed pack metadata;
- thin skills that point agents to canonical docs for tune and pack authoring.

The Pi-native `/clearance tune` toggle, temporary tune-mode analysis tools, and proposal approval UI are implemented in the extension. Keep the human interface inside Pi. Tune mode has no public CLI.

### Internal helper harness (not shipped)

`runTuneCli()` in `src/skill/clearance-tune/cli.ts` is an internal test/debug harness
that exercises replay, presentation, write-plan, and verification without Pi UI. The optional
`scripts/dev/pi-clearance-tune.cjs` wrapper drives it for local debugging. Neither is
published: `package.json` has no `bin`, and `files` excludes `bin`/`scripts`. The harness
`apply` seam is internal-only and is not the user approval path; structured proposal objects
remain the source of truth.

Run focused helper-harness tests with:

```bash
pnpm exec vitest run test/skill/apply-cli.test.ts test/skill/apply-presentation.test.ts test/skill/apply-verify.test.ts test/skill/apply-writer.test.ts
```

## Pack package structure

A third-party or personal pack collection is a normal Pi package. It can be installed from npm,
git, or a local path; Pi loads its extension either way. The package extension should listen for
`pi-clearance:packs:request` and synchronously emit `pi-clearance:packs:register` using
the public `pi-clearance/pack-registration` constants and types.

Typical package layout:

```text
package.json
src/index.ts              # Pi extension that registers packs on request
src/packs/my-pack.ts      # RawPolicyPack data
README.md or docs/*.md    # docs linked from pack metadata
```

The registration payload provides package provenance (`name`, optional `version`, install kind,
source spec, package path, entrypoint path) for display and audit. Provenance is not trust:
installation makes packs visible in the registry, while user-owned config enables them later.
Bad registrations produce issues and no active policy. `/reload` clears the in-memory snapshot
and asks package extensions to register again. Contributor extensions should keep the unsubscribe
returned by `pi.events.on` and call it from `session_shutdown`; Pi reuses the event bus across
reloads, so stale request listeners must be removed.

Trusted TypeScript rule modules are not part of the package contract. Packages register data
packs only; executable policy loading is deliberately absent. Prefer inspectable data packs and
record general DSL gaps as core matcher work. Keep detailed authoring and package-distribution
guidance in [PACK_AUTHORING.md](PACK_AUTHORING.md) rather than duplicating it in skills or
package README snippets.

## Code map

| Path | Purpose |
|---|---|
| `src/index.ts` | Pi extension composition root |
| `src/native/` | lazy Node-API loader, platform resolution, health, and fail-closed startup |
| `src/parse/` | thin native parser/analyzer/path-fact adapters and shape utilities |
| `src/policy/` | TypeScript pack authoring and native composition/decision adapters |
| `crates/clearance-core/` | Rust parser, path facts, typed matcher IR, policy, composition, replay, and adversarial kernels |
| `crates/clearance-node/` | napi-rs JSON binding and opaque policy-handle API |
| `src/packs/` | shipped bash packs and the built-in baseline |
| `src/config/` | config paths, schema, loader, and Pi project-trust resolution |
| `src/audit/` | audit entry shapes, redaction, sinks, logger |
| `src/runtime/` | tool-call handler, reviewer fallback, context, escalation, token budget |
| `src/replay/` | corpus acquisition, native-kernel adapters, proposal contracts/adapters, and structured renderers |
| `src/skill/clearance-tune/` | internal tune helper harness plus display-only structured proposal presentation seam |
| `src/skill/clearance-*/` | thin agent guidance that points to canonical docs |
| `test/` | unit, fixture, replay, runtime, and skill tests |
| `.work/` | Workbench state (active items, backlog, conventions) |

## Settings command surface and dispatcher seam

The primary command surface is `/clearance`, `/clearance setup`, `/clearance mode [off|ask|auto]`, `/clearance settings`, `/clearance status`, `/clearance packs`, `/clearance scope`, `/clearance tune`, and `/clearance why`. The former profile and auto commands are removed with no aliases.

Bare `/clearance` and `/clearance settings` open the native in-chat settings component in `src/runtime/config-commands/settings/native-ui.ts`. There is intentionally no markdown fallback for settings: hosts without Pi's `ctx.ui.custom()` surface get a no-write unavailable result instead of a transcript dump.

Settings panels must route every mutation through `dispatchSettingsAction` in `src/runtime/config-commands/settings/dispatcher.ts`. The stable action ids live in `SettingsActionId` in `src/runtime/config-commands/settings/actions.ts`. That type is the single list panels use for both write actions and drill actions.

The split is intentional:

| Action kind | Examples | Rule |
|---|---|---|
| Write | `mode.set`, reviewer model selection, scope edits, and pack enablement | Resolve policy, build a domain plan, ask for confirmation, then apply through `applyConfigCommandPlan`. |
| Drill | `reviewer.open`, `reviewer.open-advanced`, `scope.open`, `packs.open`, `briefing.open` | Render or navigate to more detail; never write config. Public labels are Safe zones, Policy dossiers, and Briefing/Debrief. |

A native settings selection or legacy `select` return is not approval. It only tells the panel which row the user picked. If that row maps to a write action, `dispatchSettingsAction` must still run the existing planner and its own confirmation step before writing. Panels must not import config writers directly and must not treat menu selection as consent.

The dispatcher keeps settings writes on the same path as direct commands: existing domain planners such as `planPostureCommandChange`, `planReviewerCommandChange`, and `planProjectScopeCommandChange`; confirmation in Pi UI; `applyConfigCommandPlan`; then policy-resolver invalidation after a changed apply. No-UI mutation contexts return the shared refusal report and write nothing.

## Runtime flow

1. Pi fires `session_start`; the policy resolver warms the config cache.
2. Pi fires `tool_call`.
3. The TypeScript runtime sends the tool input plus resolved scope/config snapshot into the lazy native engine.
4. The Rust core analyzes the tool input, parses bash structurally, derives path facts, validates/compiles data packs, and evaluates effective policy.
5. The native policy result returns `allow`, `deny`, or `review`.
6. `review` goes through the runtime reviewer path:
   - token-budget gate;
   - optional recent-context gathering;
   - model adapter when global Clearance mode is `auto`;
   - temporary escalation/contention labels for repeated denies or unresolved calls;
   - human UI fallback only after the model path is unavailable, fails, or denies/escalates;
   - block-and-log fallback.
7. Audit entries are written for policy and reviewer decisions.

Do not move safety decisions into prompt text. Prompt text is for runtime review only; deterministic policy remains the source of truth for fast paths and hard blocks.

## Parser and policy rules

The parser is bash-first and lives in the Rust native clearance core. TypeScript does not keep a second runtime parser or policy implementation after a subsystem migrates.

Policy rules use the JSON matcher DSL. The native core compiles the DSL into inspectable matcher IR so overlap checks and provenance stay visible.

Active effect precedence is fixed:

```text
deny > review > allow
```

Specificity and pack priority choose the winning reason inside the winning effect. They do not let an allow beat review or deny.

Allow rules must be overlap-decidable against the sealed floor. If overlap is unknown, the loader or writer should fail closed.

## Reviewer rules

Model review resolves one runtime decision. It does not write policy.

When changing reviewer behavior, check these surfaces together:

- `src/runtime/reviewer.ts`
- `src/runtime/reviewer-prompts.ts`
- `src/runtime/model-adapter.ts`
- `src/runtime/reviewer-context.ts`
- `src/runtime/reviewer-context-adapter.ts`
- `src/runtime/escalation.ts`
- `src/runtime/token-budget.ts`
- `src/runtime/compound-recovery.ts`
- `src/audit/entry.ts`
- `src/replay/reviewer-config-proposals.ts`

Audit labels are part of the public evidence trail. Add them deliberately and test redaction behavior.

Compound denial/recovery copy lives in `src/runtime/compound-recovery.ts` and is consumed by
`buildCompactReviewSummary`. It is presentation only: it renders existing parser/path/effect
facts and policy provenance, never changes `Decision.effect`, and should stay silent for
unrelated shell or typed tools. Add future construct/reason mappings there, then cover them in
`test/runtime/review-visibility.test.ts` and the shared compound corpus.

## Tune rules

The tune is propose-and-approve, not auto-learn.

`clearance_present` is the only approval and write path. On explicit approval it writes
only user-owned config:

- global config under the user config root;
- per-project overlay under the user config root.

Shipped-pack edits, core matcher changes, and speculative analyzer ideas route as design-input artifacts instead of direct writes; executable TypeScript rule-module ideas are cut.

When changing tune behavior, run the replay and skill tests, not only the focused unit test.

## Tests and fixtures

Useful slices:

```bash
pnpm exec vitest run test/parse-structure.test.ts test/parse-bash-projection.test.ts
pnpm exec vitest run test/policy test/packs
pnpm exec vitest run test/runtime
pnpm exec vitest run test/replay
pnpm exec vitest run test/skill
```

Run the full suite before committing:

```bash
pnpm check
pnpm test
pnpm --dir . run-script lint
```

Do not broad-stage `test/`. Fixture corpora are part of the safety contract; review fixture diffs carefully.

The bounded compound-shell acceptance corpus starts in
`test/fixtures/compound-clearance-corpus.ts`. It names the motivating loop, brace/conditional
forms, typed `edit`/`write` cases, near misses, and adversarial wrappers. Focused tests consume
that corpus across parser/path facts, pack decisions, reviewer payloads, recovery copy, and
synthetic replay deltas. Future compound or typed-tool safety work should extend the corpus
first, then update the focused suites.

## Markdown docs

Public docs should stay practical and low-hype:

- start with what the user can do;
- show commands before deep explanation;
- prefer short sentences and tables;
- avoid sales words such as "seamless", "robust", "powerful", and "leverage";
- define internal terms such as "sealed floor" and "fail closed" before using them in user-facing prose;
- link to foundation docs instead of copying long design prose.

The root README and these reference docs are user/developer docs. The foundation docs remain the design source of truth.

## Agile-workflow substrate

Work is tracked in `.work/` as plain markdown items: `active/` for in-flight
epics/features/stories, `backlog/` for parked ideas, and `CONVENTIONS.md` for
project behavior (tags, verification commands, body discipline). Read item
files directly; there is no separate query binary.

Before design, implementation, or review work, read `.work/CONVENTIONS.md` and
the relevant `docs/` foundation docs.

## Foundation docs

- [VISION.md](VISION.md) — product direction and open questions.
- [SPEC.md](SPEC.md) — behavior contract.
- [ARCHITECTURE.md](ARCHITECTURE.md) — module boundaries.
- [PRINCIPLES.md](PRINCIPLES.md) — safety and execution rules.
- [RULE_PACKS.md](RULE_PACKS.md) — shipped pack intent.
- [PACK_AUTHORING.md](PACK_AUTHORING.md) — data-pack, TypeScript-pack, and package distribution guidance.
- [REVIEWER_PROMPTS.md](REVIEWER_PROMPTS.md) — prompt and reviewer contract.
- [REFERENCE_PATTERNS.md](REFERENCE_PATTERNS.md) — reference patterns from earlier captures.
