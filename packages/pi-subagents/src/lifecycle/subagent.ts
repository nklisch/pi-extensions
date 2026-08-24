/**
 * subagent.ts — Subagent class: identity, lifecycle status, and per-subagent behavior.
 *
 * Status/stats are delegated to the SubagentState value object; listener
 * lifecycle to RunListeners; workspace prepare/dispose to WorkspaceBracket.
 * Behavior (abort, steer buffering) lives here rather than on SubagentManager.
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { debugLog, runDetached, runSafely } from "#src/debug";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import {
  type LifecycleInterceptorRegistry,
  type SubagentLifecycleExecutionPath,
  type SubagentTurnLifecycle,
} from "#src/lifecycle/lifecycle-interceptor";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { RunListeners } from "#src/lifecycle/run-listeners";
import type { SubagentSession, TurnLoopResult } from "#src/lifecycle/subagent-session";
import { SubagentState, type SubagentStatus } from "#src/lifecycle/subagent-state";
import type { LifetimeUsage } from "#src/lifecycle/usage";
import type { WorkspaceProvider } from "#src/lifecycle/workspace";
import { WorkspaceBracket } from "#src/lifecycle/workspace-bracket";
import { subscribeSubagentObserver } from "#src/observation/record-observer";
import type { RunConfig } from "#src/runtime";
import { formatModelLabel } from "#src/session/model-label";
import { resolveEffectiveThinkingLevel } from "#src/session/thinking-level";
import type { AgentInvocation, CompactionInfo, ParentSessionInfo, SessionMessage, SubagentType, ThinkingLevel } from "#src/types";

/** Per-subagent lifecycle observer — created by SubagentManager for each spawn. */
export interface SubagentLifecycleObserver {
	/** Fires when the subagent transitions to running (inside run(), after markRunning). */
	onStarted?(agent: Subagent): void;
	/** Fires once the session is created — the subagent's subagentSession is now available. */
	onSessionCreated?(agent: Subagent): void;
	/** Fires once when the initial run completes or fails (for concurrency drain). */
	onRunFinished?(agent: Subagent): void;
	/** Fires once when a resumed turn reaches a terminal state. */
	onResumedFinished?(agent: Subagent): void;
	/** Fires on compaction events during the run. */
	onCompacted?(agent: Subagent, info: CompactionInfo): void;
}

export type { SubagentStatus } from "#src/lifecycle/subagent-state";

/**
 * The result of a steer attempt. `Subagent.steer` owns the non-running
 * rejection rule and reports it here, so coordinators switch on the outcome
 * instead of pre-checking status (tell by id, with outcomes).
 */
export type SteerOutcome =
	| { kind: "delivered" }
	| { kind: "buffered" }
	| { kind: "rejected"; status: SubagentStatus };

/** A second prompt was requested while this record already owned an execution. */
export class SubagentBusyError extends Error {
	constructor(agentId: string) {
		super(`Subagent "${agentId}" is still processing a turn. Wait for it to settle before resuming.`);
		this.name = "SubagentBusyError";
	}
}

/**
 * The execution machinery a Subagent needs to run. A single mandatory
 * collaborator: production (SubagentManager.spawn) always supplies it, so run()
 * needs no "not configured" guards. The genuinely-optional behavior knobs stay
 * optional; the four inputs run() cannot proceed without are required.
 */
export interface SubagentExecution {
	/** Assembly factory that produces a born-complete SubagentSession. */
	createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
	/** Immutable spawn-time parent snapshot handed to the session factory. */
	snapshot: ParentSnapshot;
	/** Initial prompt for the turn loop. */
	prompt: string;
	/** Parent working directory handed to a workspace provider's prepare(). */
	baseCwd: string;
	observer?: SubagentLifecycleObserver;
	getRunConfig?: () => RunConfig;
	/** Resolves the registered workspace provider (if any) at run-start. */
	getWorkspaceProvider?: () => WorkspaceProvider | undefined;
	model?: Model<any>;
	maxTurns?: number;
	thinkingLevel?: ThinkingLevel;
	parentSession?: ParentSessionInfo;
	/** Service-origin identity for lifecycle callbacks; never changes child setup. */
	lifecycleParentSession?: ParentSessionInfo;
	signal?: AbortSignal;
	/** Owned by the manager; only a callback bridge reaches the child session. */
	lifecycleInterceptors?: LifecycleInterceptorRegistry;
	/** Spawn-path facts remain stable when the same child session resumes. */
	executionPath?: SubagentLifecycleExecutionPath;
}

export interface SubagentInit {
	// Identity
	id: string;
	type: SubagentType;
	description: string;
	invocation?: AgentInvocation;

	/** Execution machinery — always supplied; construct-complete, no test fallbacks. */
	execution: SubagentExecution;

	/** Lifecycle status and metrics. Defaults to a fresh queued state. */
	state?: SubagentState;
}

export class Subagent {
	// Identity — set once at construction
	readonly id: string;
	readonly type: SubagentType;
	readonly description: string;
	readonly invocation?: AgentInvocation;

	// Lifecycle status and metrics — owned by a private value object; getters and
	// mutation methods below delegate to it one line.
	private readonly state: SubagentState;
	get status(): SubagentStatus { return this.state.status; }
	get result(): string | undefined { return this.state.result; }
	get error(): string | undefined { return this.state.error; }
	get startedAt(): number { return this.state.startedAt; }
	get completedAt(): number | undefined { return this.state.completedAt; }
	get stoppedWhileQueued(): boolean { return this.state.stoppedWhileQueued; }
	get consumedAt(): number | undefined { return this.state.consumedAt; }
	get consumed(): boolean { return this.state.consumed; }
	get toolUses(): number { return this.state.toolUses; }
	get lifetimeUsage(): Readonly<LifetimeUsage> { return this.state.lifetimeUsage; }
	get compactionCount(): number { return this.state.compactionCount; }
	get turnCount(): number { return this.state.turnCount; }
	get activeTools(): ReadonlyMap<string, string> { return this.state.activeTools; }
	get responseText(): string { return this.state.responseText; }
	get maxTurns(): number | undefined { return this.execution.maxTurns; }
	/** Exact effective model label used by every operator-facing status surface. */
	get modelLabel(): string { return this._modelLabel; }
	/** Exact effective thinking level used by every operator-facing status surface. */
	get effectiveThinkingLevel(): ThinkingLevel { return this._effectiveThinkingLevel; }

	abortController: AbortController;
	private _promise?: Promise<void>;
	get promise(): Promise<void> | undefined { return this._promise; }

	private readonly execution: SubagentExecution;
	private _modelLabel: string;
	private _effectiveThinkingLevel: ThinkingLevel;
	private readonly listeners = new RunListeners();
	private readonly workspaceBracket: WorkspaceBracket;
	/** True while run()/runResume() owns the child prompt boundary. */
	private executionInFlight = false;
	/** Synchronous admission lease spanning wind-down, Pi idle, and resume. */
	private resumeReserved = false;
	private pendingResumeAbort?: AbortController;

	subagentSession?: SubagentSession;
	private releasedOutputFile?: string;
	private _sessionReleased = false;
	get sessionReleased(): boolean { return this._sessionReleased; }

	// Steer buffer — messages queued before the session is ready
	private _pendingSteers: string[] = [];
	/** Number of steer messages waiting to be delivered. */
	get pendingSteerCount(): number { return this._pendingSteers.length; }

	/** Path to the agent's session JSONL file, or undefined if not yet available. */
	get outputFile(): string | undefined {
		return this.subagentSession?.outputFile ?? this.releasedOutputFile;
	}

	/** The tool call ID that spawned this background agent, if any. */
	get toolCallId(): string | undefined {
		return this.execution.parentSession?.toolCallId;
	}

	/** Returns true when a SubagentSession is available (session is ready). */
	isSessionReady(): boolean {
		return this.subagentSession != null;
	}

	isActive(): boolean {
		return this.status === "queued" || this.status === "running" || this.resumeReserved;
	}

	isRunning(): boolean {
		return this.status === "running";
	}

	/**
	 * Steer a running agent, owning the non-running rejection rule.
	 * Returns a `rejected` outcome (with the observed status) when the agent is
	 * not running, a `buffered` outcome when the session is not yet ready, or a
	 * `delivered` outcome once the message reaches the session.
	 */
	async steer(message: string): Promise<SteerOutcome> {
		if (this.status !== "running") {
			return { kind: "rejected", status: this.status };
		}
		if (!this.subagentSession) {
			this.queueSteer(message);
			return { kind: "buffered" };
		}
		await this.subagentSession.steer(message);
		return { kind: "delivered" };
	}

	/** Return the session conversation as formatted text, or undefined if no session. */
	getConversation(): string | undefined {
		return this.subagentSession?.getConversation();
	}

	/** Return the session context window utilization (0-100), or null if unavailable. */
	getContextPercent(): number | null {
		return this.subagentSession?.getContextPercent() ?? null;
	}

	/**
	 * Subscribe to session events for live updates (e.g., conversation viewer).
	 * Returns an unsubscribe function, or undefined if no session is available.
	 */
	subscribeToUpdates(fn: (event: AgentSessionEvent) => void): (() => void) | undefined {
		return this.subagentSession?.subscribe(fn);
	}

	/** The session's message history, or an empty array if no session. */
	get messages(): readonly unknown[] {
		return this.subagentSession?.messages ?? [];
	}

	/** The session's message history typed for Pi's session-rendering machinery, or empty if no session. */
	get agentMessages(): readonly SessionMessage[] {
		return this.subagentSession?.agentMessages ?? [];
	}

	/** Resolve a registered tool definition by name, or undefined if no session. */
	getToolDefinition(name: string): ToolDefinition | undefined {
		return this.subagentSession?.getToolDefinition(name);
	}

	constructor(init: SubagentInit) {
		// Identity
		this.id = init.id;
		this.type = init.type;
		this.description = init.description;
		this.invocation = init.invocation;

		// Lifecycle status and metrics — fresh queued state unless one is supplied
		this.state = init.state ?? new SubagentState();

		// Abort controller — always created, never injected
		this.abortController = new AbortController();

		// Execution machinery — a single mandatory collaborator
		this.execution = init.execution;
		this._modelLabel = formatModelLabel(this.execution.model ?? this.execution.snapshot.model);
		this._effectiveThinkingLevel = resolveEffectiveThinkingLevel(
			this.execution.model ?? this.execution.snapshot.model,
			this.execution.thinkingLevel,
			this.execution.snapshot.thinkingLevel,
		);

		// Per-run lifecycle collaborators
		this.workspaceBracket = new WorkspaceBracket(
			this.execution.getWorkspaceProvider ?? (() => undefined),
		);
	}

	/**
	 * Execute the full agent lifecycle: workspace preparation, session creation
	 * via the factory, observer wiring, the turn loop, workspace disposal, and
	 * status transitions.
	 *
	 * Execution is supplied at construction (mandatory), so run() needs no
	 * "not configured" guards. The returned promise always resolves (errors are
	 * captured internally).
	 */
	async run(): Promise<void> {
		this.executionInFlight = true;
		this.markRunning(Date.now());
		try {
			// Observer callbacks are extension-owned sinks, not part of the agent's
			// work. A stale UI/context callback must not leave a background record
			// running with a slot held and no terminal notification.
			runSafely("subagent onStarted observer", () => this.execution.observer?.onStarted?.(this));
			this.listeners.wireSignal(this.execution.signal, () => this.abort());

			// Guard the await so the no-provider path stays synchronous, preserving
			// the original run() timing: the factory is called in the same turn as
			// spawn() when no workspace provider is registered.
			let cwd: string | undefined;
			if (this.workspaceBracket.hasProvider()) {
				cwd = await this.workspaceBracket.prepare({
					agentId: this.id,
					agentType: this.type,
					baseCwd: this.execution.baseCwd,
					invocation: this.invocation,
				});
			}

			this.subagentSession = await this.execution.createSubagentSession({
				snapshot: this.execution.snapshot,
				type: this.type,
				cwd,
				parentSession: this.execution.parentSession,
				model: this.execution.model,
				thinkingLevel: this.execution.thinkingLevel,
			});

			// The SDK session is authoritative after creation: it has applied its
			// defaults and model-capability clamp. Keep the record as the one source
			// consumed by every operator-facing status surface.
			this._modelLabel = formatModelLabel(this.subagentSession.model ?? this.execution.model ?? this.execution.snapshot.model);
			this._effectiveThinkingLevel = this.subagentSession.thinkingLevel ?? this._effectiveThinkingLevel;

			this.flushPendingSteers();
			this.listeners.attachObserver(subscribeSubagentObserver(this.subagentSession, this.state, {
				onCompact: (info) => runSafely(
					"subagent onCompacted observer",
					() => this.execution.observer?.onCompacted?.(this, info),
				),
			}));
			runSafely("subagent onSessionCreated observer", () => this.execution.observer?.onSessionCreated?.(this));

			const runConfig = this.execution.getRunConfig?.();
			const lifecycle = this.createTurnLifecycle("initial");
			const result = await this.subagentSession.runTurnLoop(this.execution.prompt, {
				maxTurns: this.execution.maxTurns,
				defaultMaxTurns: runConfig?.defaultMaxTurns,
				graceTurns: runConfig?.graceTurns,
				signal: lifecycle?.signal ?? this.abortController.signal,
				...(lifecycle ? { lifecycle } : {}),
			});
			this.completeRun(result);
		} catch (err) {
			// One outer failure path guarantees terminal state, listener release,
			// workspace cleanup, and the manager's completion funnel.
			this.failRun(err);
		} finally {
			this.executionInFlight = false;
		}
	}

	/**
	 * Start execution immediately (foreground / bypassQueue paths).
	 * Stores the run promise so it is awaitable via the `promise` getter.
	 */
	start(): void {
		this._promise = this.guardedRun();
	}

	/**
	 * Schedule execution through an external concurrency scheduler (the limiter).
	 * Captures the scheduler's promise eagerly, so a still-queued agent is
	 * awaitable via the `promise` getter from spawn — not only once its slot opens.
	 * The guard in guardedRun() makes an abort-while-queued run a no-op when the
	 * slot finally frees.
	 */
	scheduleVia(schedule: (thunk: () => Promise<void>) => Promise<void>): void {
		this._promise = schedule(() => this.guardedRun());
	}

	/**
	 * Run unless the agent left the active set before its slot opened
	 * (e.g. abort-while-queued): a non-queued, non-running status resolves
	 * immediately without running.
	 */
	private guardedRun(): Promise<void> {
		if (this.status !== "queued" && this.status !== "running") return Promise.resolve();
		return this.run();
	}

	/**
	 * Resume an existing session with a new prompt, managing the observer
	 * subscription lifecycle internally (same wiring as run()).
	 *
	 * Requires an existing SubagentSession (set when the original run created it).
	 * The returned promise always resolves (errors are captured internally).
	 * Parent cancellation and manager abort both stop the resumed turn.
	 */
	resume(prompt: string, signal?: AbortSignal): Promise<void> {
		const subagentSession = this.subagentSession;
		if (!subagentSession) {
			return Promise.reject(new Error(
				this.sessionReleased
					? "Subagent session was released and can no longer be resumed"
					: "Subagent not configured for resume — missing session",
			));
		}
		if (this.status === "queued" || this.status === "running" || this.resumeReserved) {
			return Promise.reject(new SubagentBusyError(this.id));
		}

		// Reserve synchronously before the first await. This closes both the
		// concurrent-resume race and retention's release-while-waiting race.
		this.resumeReserved = true;
		const previousExecution = this.executionInFlight ? this._promise : undefined;
		const resumeAbort = new AbortController();
		this.pendingResumeAbort = resumeAbort;
		const resumed = this.resumeWhenReady(
			subagentSession,
			previousExecution,
			prompt,
			resumeAbort,
			signal,
		);
		this._promise = resumed;
		return resumed;
	}

	private async resumeWhenReady(
		subagentSession: SubagentSession,
		previousExecution: Promise<void> | undefined,
		prompt: string,
		resumeAbort: AbortController,
		signal?: AbortSignal,
	): Promise<void> {
		const waitSignal = signal
			? AbortSignal.any([resumeAbort.signal, signal])
			: resumeAbort.signal;
		let started = false;
		try {
			// abort() marks a record stopped before AgentSession.prompt() necessarily
			// settles. Wait for both the record-owned invocation and Pi's stronger
			// idle boundary instead of racing a new prompt into the old one.
			if (previousExecution) await previousExecution;
			waitSignal.throwIfAborted();
			await subagentSession.waitUntilIdle(waitSignal);
			waitSignal.throwIfAborted();
			if (this.subagentSession !== subagentSession) {
				throw new Error("Subagent session was released while waiting to resume");
			}

			started = true;
			this.executionInFlight = true;
			this.resetForResume(Date.now(), resumeAbort);
			await this.runResume(subagentSession, prompt, signal);
		} catch (error) {
			if (waitSignal.aborted) this.markStopped();
			else this.markError(error);
			if (!started) {
				runSafely("subagent onResumedFinished observer", () => this.execution.observer?.onResumedFinished?.(this));
			}
		} finally {
			if (started) this.executionInFlight = false;
			if (this.pendingResumeAbort === resumeAbort) this.pendingResumeAbort = undefined;
			this.resumeReserved = false;
		}
	}

	private async runResume(
		subagentSession: SubagentSession,
		prompt: string,
		signal?: AbortSignal,
	): Promise<void> {
		const executionSignal = signal
			? AbortSignal.any([this.abortController.signal, signal])
			: this.abortController.signal;
		try {
			this.listeners.attachObserver(subscribeSubagentObserver(subagentSession, this.state, {
				onCompact: (info) => runSafely(
					"subagent onCompacted observer",
					() => this.execution.observer?.onCompacted?.(this, info),
				),
			}));

			const lifecycle = this.createTurnLifecycle("resume", executionSignal);
			if (lifecycle) {
				const result = await subagentSession.resumeLifecycleTurnLoop(
					prompt,
					lifecycle.signal,
					lifecycle,
				);
				if (result.failure) this.markFailed(result.failure, result.responseText);
				else if (result.aborted) this.markAborted(result.responseText);
				else if (result.steered) this.markSteered(result.responseText);
				else this.markCompleted(result.responseText);
			} else {
				const resumed = await subagentSession.resumeTurnLoop(prompt, executionSignal);
				const outcome = typeof resumed === "string" ? { text: resumed } : resumed;
				if (outcome.failure) this.markFailed(outcome.failure, outcome.text);
				else this.markCompleted(outcome.text);
			}
		} catch (err) {
			this.markError(err);
		} finally {
			this.listeners.release();
			runSafely("subagent onResumedFinished observer", () => this.execution.observer?.onResumedFinished?.(this));
		}
	}

	/** Wait for the current queued, running, or resumed execution without cancelling it. */
	async waitUntilSettled(signal: AbortSignal): Promise<void> {
		const run = this._promise;
		if (!run || (!this.executionInFlight && !this.resumeReserved) || signal.aborted) return;
		await settleOrAbort(run, signal);
	}

	/** Build a callback-only lifecycle bridge after the immutable child session exists. */
	private createTurnLifecycle(
		phase: "initial" | "resume",
		executionSignal: AbortSignal | undefined = this.abortController.signal,
	): SubagentTurnLifecycle | undefined {
		const registry = this.execution.lifecycleInterceptors;
		const session = this.subagentSession;
		if (!registry?.hasInterceptors() || !session) return undefined;
		const initialPath = this.execution.executionPath ?? {
			phase: "initial" as const,
			origin: "service" as const,
			mode: "foreground" as const,
			admission: "immediate" as const,
		};
		const lifecycleParent = this.execution.lifecycleParentSession ?? this.execution.parentSession;
		return registry.createTurnLifecycle({
			identity: {
				agentId: this.id,
				sessionId: session.sessionId,
				runId: randomUUID(),
				agentType: this.type,
				...(lifecycleParent?.parentSessionId
					? { parentSessionId: lifecycleParent.parentSessionId }
					: {}),
			},
			execution: { ...initialPath, phase },
			signal: executionSignal === this.abortController.signal
				? executionSignal
				: AbortSignal.any([this.abortController.signal, executionSignal]),
		});
	}

	/** Increment tool use count. Called by record-observer on tool_execution_end. */
	incrementToolUses(): void {
		this.state.incrementToolUses();
	}

	/** Accumulate a usage delta into lifetimeUsage. Called by record-observer on message_end. */
	addUsage(delta: { input: number; output: number; cacheWrite: number }): void {
		this.state.addUsage(delta);
	}

	/** Increment compaction count. Called by record-observer on compaction_end. */
	incrementCompactions(): void {
		this.state.incrementCompactions();
	}

	/** Transition to running state. Sets status and startedAt. */
	markRunning(startedAt: number): void {
		this.state.markRunning(startedAt);
	}

	/**
	 * Transition to completed state.
	 * Always sets result and completedAt (??=). Only changes status if not stopped.
	 */
	markCompleted(result: string, completedAt?: number): void {
		this.state.markCompleted(result, completedAt);
	}

	/**
	 * Transition to aborted state.
	 * Always sets result and completedAt (??=). Only changes status if not stopped.
	 */
	markAborted(result: string, completedAt?: number): void {
		this.state.markAborted(result, completedAt);
	}

	/**
	 * Transition to steered state.
	 * Always sets result and completedAt (??=). Only changes status if not stopped.
	 */
	markSteered(result: string, completedAt?: number): void {
		this.state.markSteered(result, completedAt);
	}

	/**
	 * Transition to error state.
	 * Always sets error (formatted) and completedAt (??=). Only changes status if not stopped.
	 */
	markError(error: unknown, completedAt?: number): void {
		this.state.markError(error, completedAt);
	}

	/** Record a provider failure and preserve any partial output. */
	markFailed(error: unknown, partialResult?: string, completedAt?: number): void {
		this.state.markFailed(error, partialResult, completedAt);
	}

	/** Transition to stopped state. Always valid — no guard. */
	markStopped(completedAt?: number): void {
		this.state.markStopped(completedAt);
	}

	markConsumed(at?: number): void {
		this.state.markConsumed(at);
	}

	/** Stop a queued agent through the same terminal observer funnel as a run. */
	stopQueued(): void {
		this.state.stopQueued();
		runSafely("subagent onRunFinished observer", () => this.execution.observer?.onRunFinished?.(this));
	}

	/**
	 * Abort a running agent: fire AbortController and transition to stopped.
	 * Returns false if the agent is not running.
	 * A still-queued agent is stopped by SubagentManager; its scheduled thunk
	 * then no-ops on the queued-status guard.
	 */
	abort(): boolean {
		if (this.status !== "running" && !this.resumeReserved) return false;
		this.abortController.abort();
		this.pendingResumeAbort?.abort();
		this.markStopped();
		return true;
	}

	/**
	 * Buffer a steer message for delivery once the session is ready.
	 * Called internally from steer() before the session is ready.
	 */
	private queueSteer(message: string): void {
		this._pendingSteers.push(message);
	}

	/**
	 * Flush all buffered steer messages to the session and clear the buffer.
	 * Called once the session is available (inside run()).
	 */
	private flushPendingSteers(): void {
		for (const msg of this._pendingSteers) {
			runDetached("subagent buffered steer", () => this.subagentSession?.steer(msg));
		}
		this._pendingSteers = [];
	}

	/** Reset for resume: running status, new startedAt, clear completedAt/result/error/listeners. */
	resetForResume(startedAt: number, controller = new AbortController()): void {
		this.abortController = controller;
		this.state.resetForResume(startedAt);
		this.listeners.release();
	}

	/** Complete a run: release listeners, dispose the workspace, status transition, notify observer. */
	completeRun(result: TurnLoopResult): void {
		this.listeners.release();

		const finalStatus: SubagentStatus = result.failure
			? "error"
			: result.aborted
				? "aborted"
				: result.steered
					? "steered"
					: "completed";
		let finalResult = result.responseText;
		try {
			finalResult += this.workspaceBracket.dispose({ status: finalStatus, description: this.description });
		} catch (error) {
			// Workspace teardown belongs to the run's terminal boundary. If it
			// fails, report an error once rather than re-entering disposal from the
			// outer catch path.
			this.failRun(error);
			return;
		}

		if (result.failure) this.markFailed(result.failure, finalResult);
		else if (result.aborted) this.markAborted(finalResult);
		else if (result.steered) this.markSteered(finalResult);
		else this.markCompleted(finalResult);

		runSafely("subagent onRunFinished observer", () => this.execution.observer?.onRunFinished?.(this));
	}

	/** Dispose the wrapped session, firing the `disposed` lifecycle event. */
	async disposeSession(): Promise<void> {
		const session = this.subagentSession;
		if (!session) return;
		// Detach first: callers must not admit a resume while asynchronous
		// extension shutdown is in progress.
		this.subagentSession = undefined;
		await session.dispose();
	}

	/** Release heavy session state while preserving the transcript pointer and record. */
	async releaseSession(): Promise<void> {
		const session = this.subagentSession;
		if (!session) return;
		this.releasedOutputFile = session.outputFile;
		// The record becomes non-resumable atomically at release admission, not
		// after extension shutdown finishes.
		this.subagentSession = undefined;
		this._sessionReleased = true;
		await session.dispose();
	}

	/** Fail a run: mark error, release listeners, best-effort workspace dispose, notify observer. */
	failRun(err: unknown): void {
		this.markError(err);
		this.listeners.release();

		try {
			this.workspaceBracket.dispose({ status: "error", description: this.description });
		} catch (cleanupErr) { debugLog("workspace dispose on agent error", cleanupErr); }

		runSafely("subagent onRunFinished observer", () => this.execution.observer?.onRunFinished?.(this));
	}
}

/** Resolve when either the run settles or the caller's wait is interrupted. */
async function settleOrAbort(run: Promise<void>, signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => {
		let done = false;
		const finish = (): void => {
			if (done) return;
			done = true;
			signal.removeEventListener("abort", finish);
			resolve();
		};
		signal.addEventListener("abort", finish, { once: true });
		void run.then(finish, finish);
	});
}
