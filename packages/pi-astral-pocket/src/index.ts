import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { recomputeActivation, type ActivationState } from "./activation.js";
import {
  DEFAULT_DISTILLER_MODEL,
  DEFAULT_DISTILLER_REASONING,
  isModelSpec,
  isReasoningLevel,
  loadConfig,
  saveConfig,
  type PocketConfig,
} from "./config.js";
import { DistillerController } from "./controller.js";
import { runDistillerPass } from "./distiller.js";
import { buildPocketGuidance } from "./guidance.js";
import { createDistillerModelClient, type DistillerModelStatus } from "./provider.js";
import { resolveProjectIdentity } from "./scope.js";
import { countNotes, defaultAgentDir, ensureLayout, pocketRoot, readScopedSummary } from "./store.js";
import { registerPocketTools } from "./tools.js";

function safeNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try { ctx.ui.notify(message, level); } catch { /* lifecycle may revoke the command context */ }
}

function outcomeText(controller: DistillerController): string {
  const outcome = controller.status();
  if (outcome.state === "completed") {
    if (outcome.result.skippedReason) return `skipped (${outcome.result.skippedReason})`;
    return `completed (${outcome.result.processed} revision(s), digest ${outcome.result.digest}, ${outcome.result.errors.length} error(s))`;
  }
  if (outcome.state === "failed") return `failed (${outcome.error})`;
  return outcome.state;
}

function modelStatus(ctx: ExtensionContext, config: PocketConfig): DistillerModelStatus {
  return createDistillerModelClient(
    ctx.modelRegistry,
    config.distiller.model,
    config.distiller.reasoning,
  ).status();
}

export default function extension(pi: ExtensionAPI): void {
  const agentDir = defaultAgentDir();
  const root = pocketRoot(agentDir);
  const sessionsDir = join(agentDir, "sessions");
  const state: ActivationState = { active: false };
  const controller = new DistillerController();
  let config = loadConfig(root);
  let currentProjectId: string | undefined;

  registerPocketTools(pi, {
    state,
    root,
    sessionsDir,
    maxSessionAgeDays: () => config.distiller.maxSessionAgeDays,
  });

  function startPass(ctx: ExtensionContext, forceDigest = false): void {
    if (!state.active || !currentProjectId) return;
    const snapshot = structuredClone(config.distiller);
    const projectId = currentProjectId;
    const client = createDistillerModelClient(ctx.modelRegistry, snapshot.model, snapshot.reasoning);
    const available = client.status().error === undefined;
    void controller.start(
      (signal) => runDistillerPass(root, sessionsDir, snapshot, {
        callModel: available ? (prompt, requestSignal, maxTokens) => client.call(prompt, requestSignal, maxTokens) : null,
        log: () => undefined,
        signal,
        forceDigest,
      }, projectId),
      (message, level) => safeNotify(ctx, message, level),
    ).catch(() => undefined);
  }

  /** Activation and command use reload config so external edits take effect. */
  function activate(ctx: ExtensionContext, startOnActivation = true, replaceSession = false): void {
    const previousConfig = config;
    const previousProjectId = currentProjectId;
    config = loadConfig(root);
    currentProjectId = resolveProjectIdentity(ctx.cwd);
    const effectiveConfigChanged = JSON.stringify(previousConfig) !== JSON.stringify(config);
    const projectChanged = previousProjectId !== undefined && previousProjectId !== currentProjectId;
    if (replaceSession || effectiveConfigChanged || projectChanged) controller.stop();

    const becameActive = recomputeActivation(pi, ctx, state, config);
    if (!state.active) {
      controller.stop();
      return;
    }
    ensureLayout(root);
    if (startOnActivation && config.distiller.enabled && (replaceSession || becameActive || effectiveConfigChanged || projectChanged)) {
      startPass(ctx);
    }
  }

  // A new session invalidates the previous session's reporting context even
  // when the selected model remains Astra.
  pi.on("session_start", (_event, ctx) => activate(ctx, true, true));
  pi.on("model_select", (_event, ctx) => activate(ctx));
  pi.on("session_shutdown", () => {
    state.active = false;
    currentProjectId = undefined;
    controller.stop();
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!state.active) return undefined;
    const projectId = currentProjectId ?? resolveProjectIdentity(ctx.cwd);
    return { systemPrompt: `${event.systemPrompt}\n\n${buildPocketGuidance(readScopedSummary(root, projectId))}` };
  });

  pi.registerCommand("pocket", {
    description: "Manage Astral Pocket: status, on/off, distiller, model, reasoning, distill, rebuild",
    getArgumentCompletions: (prefix) => {
      const values = ["status", "on", "off", "distiller on", "distiller off", "model reset", "reasoning minimal", "distill", "rebuild"];
      const filtered = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      activate(ctx, false);
      const words = args.trim().split(/\s+/).filter(Boolean);
      const verb = (words[0] ?? "status").toLowerCase();

      if (verb === "on" || verb === "off") {
        if (words.length !== 1) {
          safeNotify(ctx, `Usage: /pocket ${verb}`, "warning");
          return;
        }
        config = { ...config, enabled: verb === "on" };
        saveConfig(root, config);
        activate(ctx);
        safeNotify(ctx, verb === "on" ? "Astral Pocket enabled for Astra sessions." : "Astral Pocket disabled.");
        return;
      }

      if (verb === "distiller") {
        const value = words[1]?.toLowerCase();
        if ((value !== "on" && value !== "off") || words.length !== 2) {
          safeNotify(ctx, "Usage: /pocket distiller on|off", "warning");
          return;
        }
        config = { ...config, distiller: { ...config.distiller, enabled: value === "on" } };
        saveConfig(root, config);
        controller.stop();
        if (value === "on" && state.active) startPass(ctx);
        safeNotify(ctx, `Astral Pocket distiller ${value === "on" ? "enabled" : "disabled"}.`);
        return;
      }

      if (verb === "model") {
        const value = words.slice(1).join(" ").trim();
        const model = value === "reset" || value === "" ? DEFAULT_DISTILLER_MODEL : value;
        if (words.length > 2 || !isModelSpec(model)) {
          safeNotify(ctx, "Usage: /pocket model provider/modelId (or /pocket model reset)", "warning");
          return;
        }
        config = { ...config, distiller: { ...config.distiller, model } };
        saveConfig(root, config);
        controller.stop();
        if (state.active && config.distiller.enabled) startPass(ctx);
        const status = modelStatus(ctx, config);
        safeNotify(ctx, status.error ? `Distiller model saved but unavailable: ${status.error}` : `Distiller model: ${status.resolvedModel}.` , status.error ? "warning" : "info");
        return;
      }

      if (verb === "reasoning") {
        const value = words[1]?.toLowerCase() ?? "reset";
        const reasoning = value === "reset" ? DEFAULT_DISTILLER_REASONING : value;
        if (words.length > 2 || !isReasoningLevel(reasoning)) {
          safeNotify(ctx, "Usage: /pocket reasoning off|minimal|low|medium|high|xhigh|max|reset", "warning");
          return;
        }
        config = { ...config, distiller: { ...config.distiller, reasoning } };
        saveConfig(root, config);
        controller.stop();
        if (state.active && config.distiller.enabled) startPass(ctx);
        const status = modelStatus(ctx, config);
        safeNotify(ctx, `Distiller reasoning requested: ${reasoning}; effective: ${status.effectiveReasoning ?? "unavailable"}.`, status.error ? "warning" : "info");
        return;
      }

      if (verb === "distill" || verb === "rebuild") {
        if (words.length !== 1) {
          safeNotify(ctx, `Usage: /pocket ${verb}`, "warning");
          return;
        }
        if (!state.active) {
          safeNotify(ctx, "Astral Pocket distillation is available only in an active Astra session.", "warning");
          return;
        }
        if (!config.distiller.enabled) {
          safeNotify(ctx, "The distiller is disabled. Run /pocket distiller on first.", "warning");
          return;
        }
        startPass(ctx, verb === "rebuild");
        safeNotify(ctx, verb === "rebuild" ? "Astral Pocket digest rebuild started." : "Astral Pocket distillation started.");
        return;
      }

      if (verb !== "status" || words.length > 1) {
        safeNotify(ctx, "Usage: /pocket status|on|off|distiller on|off|model <provider/modelId>|reasoning <level>|distill|rebuild", "warning");
        return;
      }

      const notes = countNotes(root);
      const status = modelStatus(ctx, config);
      const reasoning = status.effectiveReasoning && status.effectiveReasoning !== status.requestedReasoning
        ? `${status.requestedReasoning} → ${status.effectiveReasoning}`
        : status.requestedReasoning;
      safeNotify(ctx, [
        `Pocket: ${config.enabled ? "enabled" : "disabled"}; ${state.active ? "active" : "inactive (Astra only)"}`,
        `Notes: ${notes}. Distiller: ${config.distiller.enabled ? "on" : "off"}`,
        `Model: requested ${status.requestedModel}; resolved ${status.resolvedModel ?? "unavailable"}`,
        `Reasoning: ${reasoning}${status.error ? `; ${status.error}` : ""}`,
        `Last pass: ${outcomeText(controller)}`,
        `Store: ${root}`,
      ].join("\n"), status.error ? "warning" : "info");
    },
  });
}
