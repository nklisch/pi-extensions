/** Born-complete child session: turn driving, steering, and teardown. */

import {
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { debugLog, runDetached, runSafely } from "#src/debug";
import type { ChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import type {
  SubagentLifecycleOutcome,
  SubagentTurnLifecycle,
} from "#src/lifecycle/lifecycle-interceptor";
import { normalizeMaxTurns } from "#src/lifecycle/turn-limits";
import { getSessionContextPercent, type SessionStatsLike } from "#src/lifecycle/usage";
import { extractText } from "#src/session/context";
import { getAgentConversation } from "#src/session/conversation";
import type { SessionMessage, ThinkingLevel } from "#src/types";

export type TurnLimitReason = "turn_limit_graceful" | "turn_limit_hard";

export interface TurnLoopResult {
  responseText: string;
  /** Provider failure reported by a normally-resolved assistant turn. */
  failure?: string;
  /** Turn-limit or lifecycle result owned by the session loop. */
  terminalReason?: TurnLimitReason | "lifecycle_abort";
}

export interface TurnLoopOptions {
  maxTurns?: number;
  defaultMaxTurns?: number;
  graceTurns?: number;
  signal?: AbortSignal;
  lifecycle?: SubagentTurnLifecycle;
}

export interface SubagentSessionMeta {
  outputFile: string | undefined;
  sessionId: string;
  sessionDir: string;
  agentName: string;
  agentMaxTurns: number | undefined;
  parentContext: string | undefined;
  lifecycle: ChildLifecyclePublisher;
}

export class SubagentSession {
  private disposalPromise?: Promise<void>;

  constructor(
    private readonly _session: AgentSession,
    private readonly meta: SubagentSessionMeta,
  ) {}

  /** @internal lifecycle-only access to SDK teardown hooks. */
  get session(): AgentSession { return this._session; }
  get outputFile(): string | undefined { return this.meta.outputFile; }
  get sessionId(): string { return this.meta.sessionId; }
  get model(): Model<any> | undefined { return this._session.model; }
  get thinkingLevel(): ThinkingLevel { return this._session.thinkingLevel; }

  async runTurnLoop(prompt: string, opts: TurnLoopOptions): Promise<TurnLoopResult> {
    const session = this._session;
    let turnCount = 0;
    const maxTurns = normalizeMaxTurns(opts.maxTurns ?? this.meta.agentMaxTurns ?? opts.defaultMaxTurns);
    let softLimitReached = false;
    let turnLimitReason: TurnLimitReason | undefined;

    const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
      runSafely("subagent turn-limit observer", () => {
        if (event.type !== "turn_end" || maxTurns == null) return;
        turnCount++;
        if (!softLimitReached && turnCount >= maxTurns) {
          softLimitReached = true;
          runDetached("turn-limit steer", () => session.steer(
            "You have reached your turn limit. Wrap up immediately - provide your final answer now.",
          ));
        } else if (softLimitReached && turnCount >= maxTurns + (opts.graceTurns ?? 5)) {
          turnLimitReason = "turn_limit_hard";
          runDetached("turn-limit abort", () => session.abort());
        }
      });
    });

    const startIndex = session.messages.length;
    const collector = collectResponseText(session);
    const cleanupAbort = forwardAbortSignal(session, opts.signal);
    const effectivePrompt = this.meta.parentContext ? this.meta.parentContext + prompt : prompt;

    try {
      if (opts.lifecycle) {
        return await this.driveLifecycleTurns(
          effectivePrompt,
          opts.lifecycle,
          () => collector.getText().trim() || getLastAssistantText(session, startIndex),
          () => finalTurnError(session, startIndex),
          () => turnLimitReason,
          () => softLimitReached,
        );
      }

      await session.prompt(effectivePrompt);
      const responseText = collector.getText().trim() || getLastAssistantText(session, startIndex);
      const failure = finalTurnError(session, startIndex);
      const terminalReason = failure ? undefined : turnLimitReason ?? (softLimitReached ? "turn_limit_graceful" : undefined);
      if (!failure) this.publishCompleted(terminalReason ?? "completed");
      return { responseText, failure, ...(terminalReason ? { terminalReason } : {}) };
    } finally {
      releaseTurnLoopHandles([
        ["subagent turn-limit unsubscribe", unsubTurns],
        ["subagent response collector unsubscribe", collector.unsubscribe],
        ["subagent abort forwarder detach", cleanupAbort],
      ]);
    }
  }

  async resumeTurnLoop(prompt: string, signal?: AbortSignal): Promise<{ text: string; failure?: string; terminalReason?: TurnLimitReason }> {
    const startIndex = this._session.messages.length;
    const collector = collectResponseText(this._session);
    const cleanupAbort = forwardAbortSignal(this._session, signal);
    try {
      await this._session.prompt(prompt);
      const text = collector.getText().trim() || getLastAssistantText(this._session, startIndex);
      const failure = finalTurnError(this._session, startIndex);
      if (!failure) this.publishCompleted("completed");
      return { text, failure };
    } finally {
      releaseTurnLoopHandles([
        ["subagent response collector unsubscribe", collector.unsubscribe],
        ["subagent abort forwarder detach", cleanupAbort],
      ]);
    }
  }

  async resumeLifecycleTurnLoop(
    prompt: string,
    signal: AbortSignal | undefined,
    lifecycle: SubagentTurnLifecycle,
  ): Promise<TurnLoopResult> {
    const startIndex = this._session.messages.length;
    const collector = collectResponseText(this._session);
    const cleanupAbort = forwardAbortSignal(this._session, signal);
    try {
      return await this.driveLifecycleTurns(
        prompt,
        lifecycle,
        () => collector.getText().trim() || getLastAssistantText(this._session, startIndex),
        () => finalTurnError(this._session, startIndex),
        () => undefined,
        () => false,
      );
    } finally {
      releaseTurnLoopHandles([
        ["subagent response collector unsubscribe", collector.unsubscribe],
        ["subagent abort forwarder detach", cleanupAbort],
      ]);
    }
  }

  private async driveLifecycleTurns(
    initialPrompt: string,
    lifecycle: SubagentTurnLifecycle,
    responseText: () => string,
    failure: () => string | undefined,
    turnLimitReason: () => TurnLimitReason | undefined,
    softLimitReached: () => boolean,
  ): Promise<TurnLoopResult> {
    const start = await lifecycle.beforeStart(initialPrompt);
    if (start?.action === "abort") return this.lifecycleAbort(start.reason);

    let prompt = start?.prompt ?? initialPrompt;
    let continuationRound = 0;
    for (;;) {
      lifecycle.signal.throwIfAborted();
      await this._session.prompt(prompt);
      const proposedResult = responseText();
      const turnFailure = failure();
      if (turnFailure) {
        // Provider failure is a record terminal reason, not a lifecycle outcome;
        // do not publish a misleading child-completed event.
        return { responseText: proposedResult, failure: turnFailure };
      }

      const turnReason = turnLimitReason() ?? (softLimitReached() ? "turn_limit_graceful" : undefined);
      const completion = await lifecycle.beforeComplete(
        proposedResult,
        turnReason === "turn_limit_hard" ? "turn_limit_hard" : turnReason === "turn_limit_graceful" ? "turn_limit_graceful" : "completed",
        continuationRound,
      );
      if (completion?.action === "abort") return this.lifecycleAbort(completion.reason);
      if (completion?.action === "continue") {
        if (continuationRound >= lifecycle.maxContinuationRounds) {
          return this.lifecycleAbort(`Lifecycle continuation limit of ${lifecycle.maxContinuationRounds} reached`);
        }
        continuationRound++;
        prompt = completion.prompt;
        continue;
      }

      const finalResult = completion?.action === "complete"
        ? completion.result ?? proposedResult
        : proposedResult;
      this.publishCompleted(turnReason ?? "completed");
      return { responseText: finalResult, ...(turnReason ? { terminalReason: turnReason } : {}) };
    }
  }

  private lifecycleAbort(reason: string): TurnLoopResult {
    return { responseText: reason, terminalReason: "lifecycle_abort" };
  }

  private publishCompleted(terminalReason: "completed" | TurnLimitReason): void {
    this.meta.lifecycle.completed({
      sessionDir: this.meta.sessionDir,
      agentName: this.meta.agentName,
      terminalReason,
    });
  }

  get isIdle(): boolean { return this._session.isIdle; }

  async waitUntilIdle(signal?: AbortSignal): Promise<void> {
    if (this._session.isIdle) return;
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribe: () => void = () => {};
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal?.reason ?? new Error("Resume wait aborted"));
      };
      unsubscribe = this._session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "agent_settled" || this._session.isIdle) finish();
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this._session.isIdle) finish();
      else if (signal?.aborted) onAbort();
    });
  }

  async steer(message: string): Promise<void> { await this._session.steer(message); }
  getConversation(): string { return getAgentConversation(this._session); }
  getContextPercent(): number | null { return getSessionContextPercent(this._session); }
  subscribe(fn: (event: AgentSessionEvent) => void): () => void { return this._session.subscribe(fn); }
  getSessionStats(): SessionStatsLike { return this._session.getSessionStats(); }
  get messages(): readonly unknown[] { return this._session.messages as readonly unknown[]; }
  get agentMessages(): readonly SessionMessage[] { return this._session.messages; }
  getToolDefinition(name: string): ToolDefinition | undefined { return this._session.getToolDefinition(name); }

  dispose(): Promise<void> {
    this.disposalPromise ??= this.disposeOnce();
    return this.disposalPromise;
  }

  private async disposeOnce(): Promise<void> {
    try {
      await this._session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } catch (error) {
      debugLog("child extension session_shutdown", error);
    }
    try {
      this._session.dispose();
    } catch (error) {
      debugLog("child session dispose", error);
    }
    try {
      this.meta.lifecycle.disposed({ sessionId: this.meta.sessionId });
    } catch (error) {
      debugLog("child lifecycle disposed", error);
    }
  }
}

function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    runSafely("subagent response observer", () => {
      if (event.type === "message_start" && event.message?.role === "assistant") text = "";
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") text += event.assistantMessageEvent.delta;
    });
  });
  return { getText: () => text, unsubscribe };
}

function getLastAssistantText(session: AgentSession, startIndex = 0): string {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

function finalTurnError(session: AgentSession, startIndex = 0): string | undefined {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error") return msg.errorMessage?.trim() || "provider error with no output";
    if (msg.stopReason === "length" && !extractText(msg.content).trim()) return "run hit the output token limit before producing any text";
    return undefined;
  }
  return undefined;
}

function releaseTurnLoopHandles(handles: ReadonlyArray<readonly [string, () => void]>): void {
  for (const [context, release] of handles) runSafely(context, release);
}

function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = (): void => runDetached("parent-signal abort", () => session.abort());
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return () => signal.removeEventListener("abort", onAbort);
}
