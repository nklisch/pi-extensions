# Research: `@gotgenes/pi-subagents` lifecycle interception

**Evidence date:** 2026-07-16

**Package examined:** `@gotgenes/pi-subagents@18.0.3`

**Pinned release source:** [`pi-subagents-v18.0.3` / `c76a294a777a990950da23fc06cb0caf51da7ac6`](https://github.com/gotgenes/pi-packages/tree/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents)

**Commissioning feature:** `epic-skills-hook-runtime-subagent-interception`

## Executive finding

`@gotgenes/pi-subagents@18.0.3` does **not** expose a supported pre-start or pre-completion interception contract. Its public root export provides service accessors, a read/control service, one workspace provider seam, and six observational event constants. The four lower-level child channels are emitted at useful points but are neither package exports nor decision points: handlers are synchronous observers, their return values are ignored, and their payloads omit the exact prompt or proposed result. [S1][S4][S5][S6]

Consequently, no current API can faithfully implement either foreign boundary:

- **`SubagentStart`:** no supported consumer can inspect and replace the exact prompt passed to the child's first `AgentSession.prompt()`, deny it before that call, or receive complete immutable child/parent identity plus cancellation.
- **`SubagentStop`:** no supported consumer can inspect the proposed final result and request another child turn before the result is finalized, status changes, completion events fire, or disposal becomes possible.

The correct direction is:

1. contribute a typed, ordered asynchronous lifecycle-interceptor contract upstream and consume the first qualifying release;
2. if no qualifying upstream release is available inside the delivery window, use a narrowly maintained MIT fork exposing the **identical public port**;
3. never approximate interception with events, deep imports, monkeypatching, package patching, or a reimplementation of the subagent service.

**Original blocker:** at the 2026-07-16 evaluation, production Plugin Host integration was externally blocked. The portable port, schemas, capability probe, fakes, and package-independent conformance suite proceeded without claiming availability.

**Current integration:** the published maintained fork `@nklisch/pi-subagents@18.0.4-nklisch.0` satisfies this document's gate and is integrated through one root-export adapter. Its registry integrity is `sha512-33Q8JDffXUuiT1M3XjLXCI4If9p+3AOwsUp/b5f1+B7Y5JI8Z8SVU+Dncq0umAG2IjgVYKnT9FHToFHNoZGWoQ==`; release tag `pi-subagents-v18.0.4-nklisch.0` resolves to `43efffb459f64e2f5f9aaee50d8ae5afa564f4f3`. Plugin Host reports `pi.subagents.lifecycle-interception` available only when that exact validated receipt and service are composed; drift or absence remains plugin-scoped unavailability.

## Project constraints used for evaluation

The recommendation follows the project's standing contracts:

- `SubagentStart` must run before the exact first child prompt and may inject context or stop the run.
- `SubagentStop` must run before final child completion and may request bounded continuation.
- Capability absence is explicit and plugin-scoped; event observation is not presented as interception.
- Plugin Host owns foreign hook execution and aggregation. The integration package continues to own subagent sessions, models, tools, turn driving, concurrency, steering, resume, and disposal.
- The domain depends on a Plugin Host port, not package internals. An upstream release and fallback fork must be interchangeable behind that port.

These constraints come from `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/COMPATIBILITY.md`, and the commissioning feature.

## Package, release, and health facts

### Exact release and package shape

npm's `latest` tag is **18.0.3**, published 2026-07-15. The GitHub release `pi-subagents-v18.0.3` points to commit `c76a294a777a990950da23fc06cb0caf51da7ac6`. The npm tarball's SHA-512 digest matches registry integrity, and the lifecycle/public-service source files in that tarball are byte-for-byte equal to the tag. [S1][S2]

The package is ESM, requires Node `>=22`, peers on Pi AI/coding-agent/TUI `>=0.75.0`, and declares two exports: [S1][S3]

```json
{
  "exports": {
    ".": {
      "types": "./dist/public.d.ts",
      "default": "./src/service/service.ts"
    },
    "./settings": {
      "types": "./dist/settings.d.ts",
      "default": "./src/layered-settings.ts"
    }
  },
  "pi": { "extensions": ["./src/index.ts"] }
}
```

Important packaging consequences:

- the root runtime export is TypeScript source, with a bundled declaration file for consumers;
- only `.` and `./settings` are supported subpaths;
- `src/lifecycle/child-lifecycle.ts`, managers, sessions, and turn-loop classes ship in the tarball but are blocked by the `exports` map and remain unsupported internals;
- the public declaration matches `src/service/service.ts` and does not contain lifecycle interceptor types or registration.

The package and source are **MIT** licensed. A fork is legally possible if the copyright and license notice are retained. [S18]

### Maintenance health

The project is active and high-churn rather than abandoned:

- npm records 137 versions between 2026-05-12 and 2026-07-15; four are 18.x releases. [S1]
- At the evidence snapshot, `main` was `2d7b78574155220dfd2d38110910345ff1d65606`. It had no changes since the 18.0.3 tag to the public service, service adapter, child-session factory/turn loop, or child lifecycle contract, and a source search found no interceptor API. [S19][S22]
- The active `gotgenes/pi-packages` monorepo had 272 commits touching `packages/pi-subagents` in the preceding 30 days at the evidence date; the latest main-branch CI run succeeded. [S19]
- The monorepo had 23 open issues and no open pull requests at the evidence snapshot. Open issue #466 is directly relevant: resume skips child/public completion lifecycle, notification, and history emission. [S17][S20]
- npm reported 8,273 downloads during 2026-06-16 through 2026-07-15. [S21]
- npm publishes registry signatures and provenance attestations for 18.0.3. [S1]

**Health assessment:** a credible upstream target with active maintenance and release automation. The unusually rapid major-version history makes unsupported deep imports especially unsafe. No open issue or pull request discovered by searches for interceptor, pre-start, pre-stop, prompt hook, or continuation offers the required contract.

## Verified public API

### Root exports

The root exports these runtime values only: [S4]

```ts
SUBAGENT_EVENTS
getSubagentsService()
publishSubagentsService(service)
unpublishSubagentsService()
```

The published `SubagentsService` has exactly these methods: [S4]

```ts
interface SubagentsService {
  spawn(type: string, prompt: string, options?: SpawnOptions): string;
  getRecord(id: string): SubagentRecord | undefined;
  listAgents(): SubagentRecord[];
  abort(id: string): boolean;
  steer(id: string, message: string): Promise<boolean>;
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
  registerWorkspaceProvider(provider: WorkspaceProvider): () => void;
}
```

`spawn()` returns an agent id immediately. `SubagentRecord` is a serialized snapshot with id, type, description, status, result/error, usage, and timestamps; live session, prompt, abort controller, execution collaborators, parent identity, and child session identity are deliberately absent. [S4][S7]

`registerWorkspaceProvider()` is the sole public generative seam. It can asynchronously prepare a cwd from agent id/type/base cwd/invocation and later append workspace-disposal text to the result. It receives neither the child prompt nor parent session identity, and it cannot inspect or continue a proposed completion. Only one provider may be registered. [S4][S8]

### Public event constants and actual payloads

`SUBAGENT_EVENTS` contains: [S4][S9]

| Constant | Channel | Actual timing and payload |
|---|---|---|
| `CREATED` | `subagents:created` | Background record inserted, before limiter admission/run: `{ id, type, description, isBackground: true }` |
| `STARTED` | `subagents:started` | Immediately after status becomes `running`, before workspace/session creation: `{ id, type, description }` |
| `COMPLETED` | `subagents:completed` | Background initial run only, after final status/result: event-data snapshot |
| `FAILED` | `subagents:failed` | Background initial run only, after error/stopped/aborted status: event-data snapshot |
| `COMPACTED` | `subagents:compacted` | After successful child compaction: id/type/description/reason/tokens/count |
| `STEERED` | `subagents:steered` | After an external steer was buffered/delivered: `{ id, message }` |

Completion event data is `{ id, type, description, result, error, status, toolUses, durationMs, tokens }`. Foreground runs do not call the manager's completion observer, so they emit `started` but not public `completed`/`failed`. Resume uses a separate path and emits neither. [S8][S9][S10][S17]

The event payload interfaces are not part of `dist/public.d.ts`; only the constant map is typed publicly. [S3][S4]

## Internal child lifecycle: exact timing and payload

Four additional channels are wired to `pi.events.emit()`, but their constants and payload interfaces are internal source modules rather than supported package exports. [S5][S11]

| Channel | Exact emission point | Payload |
|---|---|---|
| `subagents:child:spawning` | At the start of `createSubagentSession()`, after optional workspace preparation but before environment detection/session creation | `{ agentName, parentSessionId? }` |
| `subagents:child:session-created` | After SDK session creation and wrapper construction, synchronously immediately before `session.bindExtensions({})` | `{ sessionId, parentSessionId? }` |
| `subagents:child:completed` | Immediately after the initial `session.prompt(effectivePrompt)` resolves successfully, before response fallback extraction and before status/result finalization | `{ sessionDir, agentName, aborted, steered }` |
| `subagents:child:disposed` | When `SubagentSession.dispose()` is explicitly called | `{ sessionId }` |

The source comment describing `disposed` as an always-fired run `finally` event is stale. Actual 18.0.3 behavior retains completed sessions for resume and disposes them on bind failure, completed-record cleanup/session switching, or manager shutdown. A prompt failure does not immediately emit `disposed`. Tests explicitly assert that the turn loop emits no `disposed`; the current ADR/history describes disposal as true session disposal. [S5][S6][S8][S12]

### Event-bus semantics

Pi's event bus is EventEmitter-backed. `emit()` calls ordinary listeners synchronously on the same call stack; `pi-subagents` relies on that guarantee so a synchronous `session-created` subscriber registers the child before `bindExtensions()` begins. A real-bus permission-system test asserts registry state immediately after `emit()` with no await. [S11][S13]

This guarantee is **synchronous dispatch, not asynchronous interception**:

- the publisher's injected `emit` signature returns `void`;
- event return values are not read;
- promises returned by listeners are not awaited as decisions;
- listener exceptions/latency are not an ordered policy pipeline contract;
- no event can return a replacement prompt, abort decision, or continuation request.

The upstream architecture explicitly distinguishes unlimited observational events (“know what happened”) from rationed providers that return values the core consumes. [S14]

## Exact prompt, session creation, turn loop, and finalization paths

### Initial execution path

The initial run is:

1. `SubagentManager.spawn()` creates an immutable agent id, stores the `Subagent`, emits `created` for background work, then schedules or starts it. [S8]
2. `Subagent.run()` marks the record running and emits `started`. It optionally awaits the workspace provider. [S6][S8]
3. `createSubagentSession()` emits child `spawning`; detects the environment; resolves agent config, system prompt, tools/model/thinking; creates/reloads resources; creates a child `SessionManager` linked to `parentSessionId`; creates the SDK `AgentSession`; and wraps it. [S5][S15]
4. It emits child `session-created` synchronously, awaits `bindExtensions({})`, then applies the recursion guard. [S5][S12]
5. `Subagent.run()` flushes buffered steers, attaches observation, and calls `runTurnLoop(execution.prompt, ...)`. [S6]
6. `runTurnLoop()` installs turn-limit, response, and abort listeners. Only then does it compute the exact first user prompt as `parentContext ? parentContext + prompt : prompt` and call `session.prompt(effectivePrompt)`. [S6][S16]
7. On successful return, it emits child `completed`, removes listeners, extracts response text, and returns `{ responseText, aborted, steered }`. [S16]
8. `Subagent.completeRun()` releases listeners, disposes the workspace and appends its addendum, sets final status/result/timestamp, then calls `onRunFinished`. For background runs, that observer emits public `completed`/`failed`, persists history, and schedules notification. [S6][S8][S9]
9. The child session remains live for resume until later explicit cleanup/disposal. [S6][S8]

The user task begins as the `prompt` tool/service argument. `inheritContext` captures the parent conversation at spawn time; `runTurnLoop()` prepends that rendered context to the first prompt. The child's system prompt is assembled separately from the parent system prompt, active-agent tag, environment, and agent configuration, then supplied through `systemPromptOverride` during session creation. [S15][S16]

### Error, cancellation, foreground, and resume differences

- Parent tool cancellation is wired to `Subagent.abort()`, which aborts the child session and marks the record stopped. The public service's `spawn()` has no `AbortSignal` option. [S4][S6]
- A queued public/background agent can be aborted by agent id before session creation; there is no interceptor-specific cancellation context. [S8]
- `session.prompt()` rejection skips child `completed`; `failRun()` sets error and later background `failed`, but does not immediately dispose the session. [S6][S16]
- Foreground completion is returned inline and does not emit manager-level `completed`/`failed`. [S8][S9]
- `resumeTurnLoop(prompt)` calls `session.prompt(prompt)` directly, with no parent-context prepend and no child `completed`. `Subagent.resume()` marks terminal state directly and does not call `onRunFinished`; open issue #466 records the missing public lifecycle/history/notification. [S6][S16][S17]
- Public service spawning builds a parent snapshot but does not pass `ParentSessionInfo` to the manager, so child `spawning`/`session-created` receive no `parentSessionId` on that path. Tool spawning does pass parent session file/id/tool-call id. [S7]

## Interception capability verdict

### Supported pre-start interceptor

**Absent.** There is no public registration method, interceptor type, or callback that is awaited before first prompt. No current event carries all of:

- immutable agent id and agent type;
- child session/execution identity;
- parent session identity for every spawn path;
- the exact `effectivePrompt` passed to `session.prompt()`;
- an abort signal;
- a supported return channel for prompt replacement, context injection, or denial.

The closest events are insufficient: `started` has agent id but no prompt/parent/session; child `spawning` has parent id/type but no agent id/prompt; child `session-created` has session/parent ids but no agent id/type/prompt. All are observational. [S5][S9][S11]

### Supported pre-stop interceptor

**Absent.** No current callback is awaited after response capture but before finalization. Child `completed` fires too early to carry the assembled response and too late to prevent the just-finished turn; its payload has no result or agent id. Public `completed`/`failed` carry result only after status and result are committed, only for background initial runs. `disposed` is later session cleanup, not completion. `steer()` rejects non-running agents, so an observer cannot reliably turn a completed run into continuation. [S6][S8][S9][S16]

### Cancellation and identity

Current public control supports `abort(agentId)` and live `steer(agentId, message)`, but lifecycle observers do not receive a cancellation signal. Agent id is generated before run, child session id later, and parent session id is optional and absent from public-service spawns. No public immutable execution-attempt identity distinguishes initial execution from resume. [S4][S7][S8]

## Why events cannot faithfully implement foreign hooks

### `SubagentStart`

Observing `created`, `started`, `child:spawning`, or `child:session-created` cannot provide equivalence:

1. no one event has exact prompt plus complete identity;
2. the exact prompt is assembled later inside `runTurnLoop()`;
3. synchronous listeners cannot return a prompt or decision;
4. async hook execution cannot be awaited by EventEmitter dispatch;
5. throwing or calling `abort(id)` from an observer is not a typed denial contract and races differently across queue/tool/service paths;
6. context sent through `steer()` becomes a later conversation message, not the exact first prompt.

### `SubagentStop`

Observing `child:completed`, public `completed`/`failed`, or `disposed` cannot provide equivalence:

1. child `completed` lacks the proposed result and excludes errors/resume;
2. public completion occurs after status/result mutation and excludes foreground/resume;
3. disposal may occur minutes later or at session switch/shutdown;
4. no event pauses completion while a command hook runs;
5. no event return can request another turn;
6. post-completion resume is a separate externally initiated operation with different lifecycle and currently missing completion signals.

These gaps change observable ordering and behavior. Calling such a bridge “supported” would violate the project's honest-compatibility rule.

## Options evaluated

| Option | Fit | Available now | Decision |
|---|---:|---:|---|
| Upstream typed interceptor contribution and release | 5/5 | 1/5 | **Preferred**; blocked until a qualifying release |
| Narrow maintained fork with identical public port | 4/5 | 1/5 | Approved fallback only if upstream timing fails |
| Event-bus observation | 1/5 | 5/5 | Reject as non-equivalent |
| Deep imports, monkeypatching, or patched-package internals | 1/5 | 2/5 | Reject |
| Reimplement the subagent service | 0/5 | 1/5 | Reject |

### Upstream contribution

This aligns with upstream's architecture: the existing ADR says providers are appropriate when the core must consume a returned value, and “no vacant hooks” is satisfied because Plugin Host is a concrete consumer. The change should add a narrow lifecycle provider/interceptor surface rather than expose managers or sessions. [S14]

Advantages: one maintained execution engine, upstream tests cover lifecycle ordering, and future queue/session/resume changes remain centralized. Risk: review/release timing is external, and the interceptor must deliberately extend an architecture that currently rations generative seams.

### Maintained fork

MIT permits a fork. The fallback must preserve upstream history/license, carry only the public interception seam and conformance tests, track upstream releases, and export the same API that Plugin Host expects from upstream. Plugin Host must not branch on upstream-versus-fork behavior.

No qualifying fork is declared or published today.

### Events

Events remain useful for telemetry, UI, permission-session registration, and diagnostics. They are explicitly observational and cannot become hook control points merely because dispatch is synchronous.

### Deep imports, monkeypatch, or package patching

The `exports` map blocks lifecycle subpaths. The extension's manager and session objects are closure-private; root access yields only a serialized service. Package patching or loader monkeypatching would couple to fast-moving internal line structure, bypass semver, and still require ownership of ordering/cancellation/disposal behavior. Reject even as a temporary production adapter.

### Reimplementation

Reimplementing would duplicate agent config, model resolution, parent snapshots, resource/session creation, persistence, extension binding, recursion prevention, concurrency, turn limits, steering, resume, usage, notifications, and cleanup. This directly violates the architecture and creates a second subagent runtime.

## Exact minimum upstream/fork API

Names are negotiable; semantics are not. The contract should be a documented root or explicit package subpath export and should extend `SubagentsService` with ordered lifecycle registration.

```ts
interface SubagentExecutionIdentity {
  readonly agentId: string;       // stable manager record
  readonly sessionId: string;     // stable child session
  readonly runId: string;         // unique initial/resume execution attempt
  readonly agentType: string;
  readonly parentSessionId?: string;
}

interface SubagentStartContext {
  readonly identity: SubagentExecutionIdentity;
  readonly prompt: string;        // exact next value for AgentSession.prompt()
  readonly signal: AbortSignal;
}

type SubagentStartDecision =
  | { action: "continue"; prompt?: string }
  | { action: "abort"; reason: string };

interface SubagentCompletionContext {
  readonly identity: SubagentExecutionIdentity;
  readonly proposedResult: string;
  readonly outcome: "completed" | "steered" | "aborted";
  readonly continuationRound: number;
  readonly signal: AbortSignal;
}

type SubagentCompletionDecision =
  | { action: "complete"; result?: string }
  | { action: "continue"; prompt: string }
  | { action: "abort"; reason: string };

interface SubagentLifecycleInterceptor {
  beforeStart?(ctx: SubagentStartContext): Promise<SubagentStartDecision | void>;
  beforeComplete?(ctx: SubagentCompletionContext): Promise<SubagentCompletionDecision | void>;
  dispose?(): void | Promise<void>;
}

interface SubagentsService {
  registerLifecycleInterceptor(interceptor: SubagentLifecycleInterceptor): () => void;
}
```

### Required semantics

1. **Registration and order:** registration order is deterministic. A stable snapshot of active interceptors runs sequentially for one boundary; async callbacks are awaited. Registration returns an idempotent disposer. Disposed interceptors receive no new executions; in-flight callbacks finish or are aborted by the execution signal.
2. **Identity:** `agentId`, `sessionId`, `runId`, `agentType`, and parent identity are immutable. Tool and public-service spawns populate parent identity consistently when an active parent session exists. Initial and resumed executions have distinct `runId` values.
3. **Exact start boundary:** `beforeStart` runs after the exact user prompt is assembled (including inherited parent context) and immediately before the corresponding `AgentSession.prompt()` call. Interceptor prompt replacements feed the next interceptor and the final value is the sole prompt sent on that turn.
4. **Abort:** start abort prevents the first prompt and produces a typed terminal outcome without fabricating completion. Cancellation while awaiting an interceptor aborts the wait/run and does not start a turn afterward.
5. **Exact completion boundary:** response collection produces `proposedResult`; `beforeComplete` runs before workspace disposal/result addendum, status/timestamp mutation, child/public completion emission, notification/history, or session disposal.
6. **Continuation:** a `continue` decision sends its prompt to the same child session, obtains a new proposed result, and re-enters `beforeComplete`. No completion/status/event/disposal occurs between rounds.
7. **Bounded loop:** the runtime enforces a finite configured maximum continuation count. Exceeding it yields an explicit typed terminal result; it never silently ignores continuation or loops indefinitely. Each round receives its index and the same cancellation signal.
8. **Result flow:** an optional replacement result feeds later interceptors and finalization. The final accepted result, plus normal workspace addendum, is the only result committed/emitted.
9. **Coverage:** semantics apply to foreground, background, queued-after-admission, public-service, tool, initial, and resume executions. Existing no-interceptor behavior remains unchanged.
10. **Failure and disposal:** interceptor throws/rejections become typed run failures with deterministic event/status ordering. Registration/service shutdown aborts in-flight work as documented and calls interceptor disposal exactly once.
11. **Encapsulation:** no public manager, `AgentSession`, mutable record, or transport/model internals are exposed. Plugin Host receives only the lifecycle port it needs.

Plugin Host should register one interceptor and continue to aggregate all installed foreign command hooks itself. Package-level interceptor ordering enables composition with other extensions; it does not move foreign hook policy into `pi-subagents`.

## Objective qualifying release/fork gate

A production adapter may be selected only when **all** of the following are true:

1. npm exposes a released version with a documented typed export for the contract above; an issue, branch, commit SHA, or open PR is not sufficient.
2. The release tag resolves to a full commit, package integrity is pinned, MIT notices are present, and package engines/peer ranges support Plugin Host's Node 24 and active Pi version.
3. The production package passes a package-independent conformance suite proving:
   - sequential ordered async registration and idempotent unregister/disposal;
   - exact first-prompt replacement and start abort before `session.prompt()`;
   - immutable agent/session/run/parent identity on tool and service paths;
   - cancellation while awaiting each boundary;
   - proposed-result inspection before status/events/history/notification/disposal;
   - bounded same-session continuation and final-result replacement;
   - correct failure behavior and no partial completion;
   - foreground/background/queued/initial/resume coverage;
   - unchanged behavior when no interceptor is registered.
4. A real Pi event-bus/session integration test proves completion and child events occur only after the interceptor accepts completion.
5. The Plugin Host capability probe tests behavior/version, not merely method presence, and returns unavailable on mismatch.

For a fallback fork, additionally require:

- a named maintained npm package and repository based on the current upstream release history;
- the same exported types and conformance suite as the proposed upstream port;
- no behavioral divergence outside the interception seam;
- automated upstream-update and CI evidence, with an identified maintainer in project dependency policy;
- a clean switch back to upstream by changing package selection only, not Plugin Host domain/application code.

The maintained fork now passes this gate. `pi.subagents.lifecycle-interception` remains unavailable whenever the exact receipt or public service is absent, malformed, or runtime-incompatible.

## What can proceed while production is blocked

Implementable locally and portably:

- Plugin Host's `SubagentLifecyclePort` and runtime capability fact;
- schemas/types for immutable execution identity, start/completion decisions, bounded continuation outcomes, and redacted errors;
- mapping from normalized foreign `SubagentStart`/`SubagentStop` hook output into the port;
- deterministic local aggregation of multiple plugin hooks;
- fakes for prompt replacement, denial, continuation, cancellation, and disposal;
- a package-independent conformance suite/probe that can run against upstream or fork;
- compatibility behavior that marks only plugins declaring subagent hooks unavailable when the capability is absent.

Production work resolved by the published maintained fork:

- import only the supported root interceptor-registration API;
- preserve exact first-prompt mutation/denial and pre-status result continuation;
- report `pi.subagents.lifecycle-interception` available only from the pinned behavioral receipt;
- verify packed real-Pi composition while keeping all lifecycle execution policy in the package.

## Recommendation

Proceed upstream-first with the narrow contract and conformance gate above. Upstream already has a consciously rationed provider architecture and a concrete public workspace seam, so an ordered lifecycle interceptor is a coherent additive extension when justified by this real consumer. Consume only a published qualifying release.

If upstream does not release the contract in the required delivery window, establish a narrowly maintained MIT fork with the identical export and tests. Keep Plugin Host's portable port and hook semantics independent of package selection.

Do not use observational events, deep imports, monkeypatching, package patches, post-completion steering/resume, or a second subagent implementation as an interim compatibility claim.

## Sources

All mutable external facts were checked on 2026-07-16.

- **[S1]** [npm registry metadata for `@gotgenes/pi-subagents`](https://registry.npmjs.org/%40gotgenes%2Fpi-subagents) — latest tag, publication history, 18.0.3 package metadata, integrity, signatures, provenance, engines, peers, and exports.
- **[S2]** [GitHub release `pi-subagents-v18.0.3`](https://github.com/gotgenes/pi-packages/releases/tag/pi-subagents-v18.0.3) and [tag commit](https://github.com/gotgenes/pi-packages/commit/c76a294a777a990950da23fc06cb0caf51da7ac6) — release/tag identity.
- **[S3]** [Pinned `package.json`](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/package.json) and [published `dist/public.d.ts`](https://unpkg.com/@gotgenes/pi-subagents@18.0.3/dist/public.d.ts) — supported package/runtime/type export surface.
- **[S4]** [Pinned public service](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/service/service.ts#L35-L119) — `SpawnOptions`, record, exact service methods, event constants, and accessors.
- **[S5]** [Pinned child-session factory](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/lifecycle/create-subagent-session.ts#L138-L244) — spawning/session-created timing, session creation, bind ordering, recursion guard, and bind-failure disposal.
- **[S6]** [Pinned `Subagent`](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/lifecycle/subagent.ts#L223-L474) — run/resume, cancellation, turn-loop call, finalization, result/status ordering, and failure path.
- **[S7]** [Pinned service adapter](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/service/service-adapter.ts#L36-L129) — public spawn path, missing parent-session handoff, model resolution, and record serialization.
- **[S8]** [Pinned manager](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/lifecycle/subagent-manager.ts#L85-L335) — agent id, queue/start timing, workspace provider, background-only completion observer, abort, cleanup, and disposal.
- **[S9]** [Pinned observational event emitter](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/observation/subagent-events-observer.ts#L35-L91) — public event timing and background completion side effects.
- **[S10]** [Pinned completion event-data builder](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/observation/notification.ts#L101-L120) — exact completed/failed payload.
- **[S11]** [Pinned child lifecycle contract](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/lifecycle/child-lifecycle.ts) — internal channels, payloads, void emit seam, and synchronous subscriber requirement.
- **[S12]** [Pinned lifecycle-order tests](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/test/lifecycle/create-subagent-session.test.ts#L121-L207) and [turn-loop lifecycle tests](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/test/lifecycle/subagent-session.test.ts#L161-L215) — verified ordering, success/error emissions, and separate disposal.
- **[S13]** [Permission-system real event-bus test](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-permission-system/test/authority/subagent-lifecycle-events.test.ts#L31-L47) — synchronous EventEmitter-backed dispatch before `emit()` returns.
- **[S14]** [ADR 0002](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/docs/decisions/0002-extensions-on-a-minimal-core.md) — observational-versus-generative discriminator and no-vacant-hooks rule.
- **[S15]** [Pinned session config](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/session/session-config.ts#L143-L187), [prompt builder](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/session/prompts.ts#L31-L85), and [parent snapshot](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/lifecycle/parent-snapshot.ts#L34-L48) — system prompt and inherited-context assembly.
- **[S16]** [Pinned child turn loop](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/lifecycle/subagent-session.ts#L82-L199) — exact effective prompt, prompt call, child-completed timing, resume path, and disposal.
- **[S17]** [Open issue #466](https://github.com/gotgenes/pi-packages/issues/466) — maintainer-recorded resume lifecycle/history/notification gap.
- **[S18]** [Pinned MIT license](https://github.com/gotgenes/pi-packages/blob/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/LICENSE) — modification/redistribution terms.
- **[S19]** [Monorepo commit history for the package](https://github.com/gotgenes/pi-packages/commits/main/packages/pi-subagents) and [CI workflow runs](https://github.com/gotgenes/pi-packages/actions/workflows/ci.yml) — maintenance/CI activity.
- **[S20]** [GitHub repository API](https://api.github.com/repos/gotgenes/pi-packages), [open issues API](https://api.github.com/repos/gotgenes/pi-packages/issues?state=open&per_page=100), and [open PRs API](https://api.github.com/repos/gotgenes/pi-packages/pulls?state=open&per_page=100) — health snapshot.
- **[S21]** [npm last-month downloads API](https://api.npmjs.org/downloads/point/last-month/%40gotgenes%2Fpi-subagents) — adoption snapshot.
- **[S22]** [Current `main` commit](https://github.com/gotgenes/pi-packages/commit/2d7b78574155220dfd2d38110910345ff1d65606) plus pinned raw [public service](https://raw.githubusercontent.com/gotgenes/pi-packages/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/service/service.ts), [child factory](https://raw.githubusercontent.com/gotgenes/pi-packages/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/lifecycle/create-subagent-session.ts), [turn loop](https://raw.githubusercontent.com/gotgenes/pi-packages/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/lifecycle/subagent-session.ts), and [child lifecycle](https://raw.githubusercontent.com/gotgenes/pi-packages/c76a294a777a990950da23fc06cb0caf51da7ac6/packages/pi-subagents/src/lifecycle/child-lifecycle.ts) — current-branch comparison and exact source used for API/lifecycle verification.
