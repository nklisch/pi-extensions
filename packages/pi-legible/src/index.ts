import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyRewrites, restoredClones, restoreOriginals, textBlockIndexes, type BlockOriginals } from "./blocks.js";
import { existsSync } from "node:fs";
import { clampDepth, loadConfig, MAX_CONTEXT_DEPTH, projectConfigPath, saveGlobalConfig, type ResolvedLegibleConfig } from "./config.js";
import { formatHistory, MessageHistory } from "./history.js";
import { DEFAULT_RULES, loadRules, RULES_FILE_NAME, type LoadedRules } from "./rules.js";
import { resolveRewriterModel, rewriteText } from "./rewrite.js";

/**
 * pi-legible — rewrites assistant prose through a second model for
 * legibility before it lands in the chat stream.
 *
 * Mechanics:
 * - `message_end` replacement swaps rewritten text into the finalized
 *   assistant message (pi has no mid-stream rewrite hook, so the original
 *   streams live and the rewrite replaces it once the message completes).
 * - Originals are stashed in-memory keyed by message timestamp, and the
 *   `context` hook swaps them back in before each LLM call — the human
 *   sees legible prose while the agent keeps full fidelity of its own
 *   history. (After a session restore from disk the stash is empty and
 *   the agent sees rewritten text for old messages; only new rewrites
 *   are covered. Accepted limitation.)
 * - The rewriter sees only a small configurable slice of recent
 *   conversation (originals, never rewrites), optionally including tool
 *   calls, plus the rules from LEGIBLE.md or built-in defaults.
 */

// Cap on stashed originals; FIFO eviction. Sized well above a typical
// turn count before compaction: evicted entries mean those messages show
// the agent rewritten text on future turns, so the cap must be generous.
// (Each entry is a few strings; 2000 entries ≈ a few MB worst case.)
const STASH_CAPACITY = 2000;

interface LegibleState {
  config: ResolvedLegibleConfig;
  rules: LoadedRules;
  history: MessageHistory;
  /** message timestamp → per-block original text */
  originals: Map<number, BlockOriginals>;
  /** Notify about a failing rewriter once per session, not per message. */
  failureNotified: boolean;
}

function createState(): LegibleState {
  return {
    config: { enabled: true, model: undefined, contextDepth: 6, includeToolCalls: true },
    rules: { text: DEFAULT_RULES, source: undefined },
    history: new MessageHistory(),
    originals: new Map(),
    failureNotified: false,
  };
}

function stashOriginals(state: LegibleState, timestamp: number, blocks: BlockOriginals): void {
  state.originals.set(timestamp, blocks);
  while (state.originals.size > STASH_CAPACITY) {
    const oldest = state.originals.keys().next().value;
    if (oldest === undefined) break;
    state.originals.delete(oldest);
  }
}

export default function extension(pi: ExtensionAPI): void {
  let state = createState();

  function reload(ctx: ExtensionContext): void {
    const trusted = ctx.isProjectTrusted();
    state = { ...createState(), history: state.history, originals: state.originals };
    state.config = loadConfig(ctx.cwd, { trusted });
    state.rules = loadRules(ctx.cwd, { trusted });
  }

  pi.on("session_start", async (_event, ctx) => {
    state = createState();
    reload(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message;

    if (message.role === "user" || message.role === "toolResult") {
      state.history.push(message);
      return;
    }
    if (message.role !== "assistant") return;

    // The rewriter needs context from BEFORE this message; snapshot first.
    const transcript = state.config.contextDepth > 0
      ? formatHistory(state.history.recent(state.config.contextDepth), {
          includeToolCalls: state.config.includeToolCalls,
        })
      : "";
    state.history.push(message);

    if (!state.config.enabled) return;
    if (message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage !== undefined) return;

    const blockIndexes = textBlockIndexes(message.content);
    if (blockIndexes.length === 0) return;

    setStatusSafely(ctx, "✍ legible: rewriting…");
    try {
      // One rewrite call per text block, concurrently — keeps each block in
      // its original position relative to interleaved tool calls.
      const rewrites = await Promise.all(
        blockIndexes.map(async (index) => {
          const block = message.content[index] as TextContent;
          const result = await rewriteText(
            { rules: state.rules.text, contextTranscript: transcript, text: block.text },
            {
              registry: ctx.modelRegistry,
              spec: state.config.model,
              fallback: ctx.model,
              signal: ctx.signal,
            },
          );
          return { index, result };
        }),
      );

      const succeeded = new Map<number, string>();
      let firstError: string | undefined;
      for (const { index, result } of rewrites) {
        if (result.ok) succeeded.set(index, result.text);
        else firstError ??= result.error;
      }

      if (succeeded.size === 0) {
        notifyFailureOnce(ctx, state, firstError ?? "rewrite failed");
        return;
      }
      if (firstError !== undefined) notifyFailureOnce(ctx, state, `some blocks kept original: ${firstError}`);

      const { content: newContent, originals } = applyRewrites(message.content, succeeded);
      stashOriginals(state, message.timestamp, originals);
      return { message: { ...message, content: newContent } };
    } finally {
      // The rewrite result is the primary event outcome. A session replacement
      // can invalidate the captured UI context while the model call is in
      // flight; stale status cleanup must not turn a successful rewrite into a
      // rejected event.
      setStatusSafely(ctx, undefined);
    }
  });

  // Restore originals so the agent (not the human) keeps full fidelity.
  pi.on("context", async (event) => {
    restoreInto(event.messages, state);
    return { messages: event.messages };
  });

  // Compaction summarizes the PERSISTED (rewritten) messages without going
  // through the context hook. Restore originals into the preparation
  // arrays so the summary — which replaces this history going forward —
  // is generated from full-fidelity text. The preparation arrays alias
  // live session-entry objects, so splice in restored CLONES: a cancelled
  // or failed compaction must leave the live session untouched.
  // Cross-restart the stash is gone and the persisted rewrites are what
  // get summarized — documented limit.
  pi.on("session_before_compact", async (event) => {
    if (state.originals.size === 0) return;
    spliceIn(
      event.preparation.messagesToSummarize,
      restoredClones(event.preparation.messagesToSummarize, state.originals),
    );
    spliceIn(
      event.preparation.turnPrefixMessages,
      restoredClones(event.preparation.turnPrefixMessages, state.originals),
    );
  });

  pi.registerCommand("legible", {
    description: "Configure second-model prose rewriting (status, on/off, model, depth, tools, rules)",
    handler: async (args, ctx) => handleCommand(args.trim(), ctx),
  });

  async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const [sub = "status", ...rest] = args.split(/\s+/).filter((s) => s.length > 0);
    const value = rest.join(" ");

    switch (sub) {
      case "status": {
        ctx.ui.notify(statusText(ctx), "info");
        return;
      }
      case "on":
      case "off": {
        saveGlobalConfig({ enabled: sub === "on" });
        reload(ctx);
        ctx.ui.notify(`legible: rewriting ${state.config.enabled ? "enabled" : "disabled"}${maskedNote(ctx)}`, "info");
        return;
      }
      case "model": {
        if (value.length === 0) {
          ctx.ui.notify(`legible: ${modelText(ctx)}`, "info");
          return;
        }
        if (value === "default" || value === "clear") {
          saveGlobalConfig({ model: undefined });
          reload(ctx);
          ctx.ui.notify(`legible: ${modelText(ctx)}${maskedNote(ctx)}`, "info");
          return;
        }
        saveGlobalConfig({ model: value });
        reload(ctx);
        ctx.ui.notify(`legible: ${modelText(ctx)}${maskedNote(ctx)}`, "info");
        return;
      }
      case "depth": {
        const parsed = Number(value);
        if (value.length === 0 || !Number.isFinite(parsed)) {
          ctx.ui.notify(`legible: context depth is ${state.config.contextDepth} (usage: /legible depth <0–${MAX_CONTEXT_DEPTH}>)`, "info");
          return;
        }
        saveGlobalConfig({ contextDepth: clampDepth(parsed) });
        reload(ctx);
        ctx.ui.notify(`legible: rewriter now sees the last ${state.config.contextDepth} messages${maskedNote(ctx)}`, "info");
        return;
      }
      case "tools": {
        if (value !== "on" && value !== "off") {
          ctx.ui.notify(`legible: tool-call context is ${state.config.includeToolCalls ? "on" : "off"} (usage: /legible tools on|off)`, "info");
          return;
        }
        saveGlobalConfig({ includeToolCalls: value === "on" });
        reload(ctx);
        ctx.ui.notify(`legible: tool-call context ${state.config.includeToolCalls ? "on" : "off"}${maskedNote(ctx)}`, "info");
        return;
      }
      case "rules": {
        ctx.ui.notify(
          state.rules.source !== undefined
            ? `legible: rewrite rules from ${state.rules.source}`
            : `legible: using built-in default rules (drop a ${RULES_FILE_NAME} in the project root or ~/.pi/agent/ to customize)`,
          "info",
        );
        return;
      }
      case "reload": {
        reload(ctx);
        ctx.ui.notify("legible: config and rules reloaded from disk", "info");
        return;
      }
      default: {
        ctx.ui.notify(
          "legible commands: status · on|off · model [<spec>|default] · depth <n> · tools on|off · rules · reload",
          "warning",
        );
      }
    }
  }

  function modelText(ctx: ExtensionContext): string {
    const resolved = resolveRewriterModel(ctx.modelRegistry, state.config.model, ctx.model);
    const source = state.config.model !== undefined ? `configured "${state.config.model}"` : "session model";
    return resolved.kind !== "unavailable"
      ? `rewriter model: ${resolved.model.provider}/${resolved.model.id} (${source})`
      : `rewriter model: none available (${resolved.error})`;
  }

  // Command writes go to the GLOBAL config; a project override can mask
  // them. Say so instead of reporting a change that did not take effect.
  // (Untrusted projects ignore the project file entirely — no note needed.)
  function maskedNote(ctx: ExtensionContext): string {
    if (!ctx.isProjectTrusted()) return "";
    return existsSync(projectConfigPath(ctx.cwd))
      ? " (note: this project's .pi/pi-legible.json may override it)"
      : "";
  }

  function statusText(ctx: ExtensionContext): string {
    return [
      `legible: ${state.config.enabled ? "enabled" : "disabled"}`,
      modelText(ctx),
      `context depth: last ${state.config.contextDepth} messages, tool calls ${state.config.includeToolCalls ? "included" : "excluded"}`,
      `rules: ${state.rules.source ?? "built-in defaults"}`,
    ].join("\n");
  }
}

function restoreInto(messages: readonly { role: string }[], state: LegibleState): void {
  if (state.originals.size === 0) return;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const blocks = state.originals.get((message as AssistantMessage).timestamp);
    if (blocks === undefined) continue;
    restoreOriginals((message as AssistantMessage).content, blocks);
  }
}

function spliceIn<T>(target: T[], source: readonly T[]): void {
  target.splice(0, target.length, ...source);
}

function notifyFailureOnce(ctx: ExtensionContext, state: LegibleState, reason: string): void {
  if (state.failureNotified) return;
  state.failureNotified = true;
  ctx.ui.notify(`legible: rewrite failed, showing original (${reason}). Further failures this session will be silent.`, "warning");
}

function setStatusSafely(ctx: ExtensionContext, text: string | undefined): void {
  try {
    ctx.ui.setStatus("legible", text);
  } catch {
    // Status is auxiliary UI state. A stale context has no safe notification
    // channel, and must not replace the rewrite or cleanup outcome.
  }
}