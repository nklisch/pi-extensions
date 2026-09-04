import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { recomputeActivation, type ActivationState } from "./activation.js";
import { DISTILLER_MODEL_PREFERENCE, loadConfig, saveConfig, type PocketConfig } from "./config.js";
import { runDistillerPass } from "./distiller.js";
import { buildPocketGuidance } from "./guidance.js";
import { readRegistryLines, readSummaryCapped, ensureLayout, pocketRoot, defaultAgentDir } from "./store.js";
import { registerPocketTools } from "./tools.js";

/** Extract text from a completed AssistantMessage, failing on error stops. */
function messageText(message: { stopReason?: string; errorMessage?: string; content: unknown }): string {
  if (message.stopReason === "error") throw new Error(message.errorMessage ?? "model error");
  if (!Array.isArray(message.content)) return "";
  return (message.content as { type?: string; text?: string }[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/** Resolve the distiller's cheap model: config override first, then the
 * preference list, first entry the registry can resolve. Returns null when
 * nothing resolves — the distiller then degrades to the mechanical floor. */
function makeCallModel(ctx: ExtensionContext, config: PocketConfig): ((prompt: string) => Promise<string>) | null {
  const candidates = config.distiller.model
    ? [config.distiller.model]
    : DISTILLER_MODEL_PREFERENCE;
  for (const ref of candidates) {
    const slash = ref.indexOf("/");
    const providerId = ref.slice(0, slash);
    const modelId = ref.slice(slash + 1);
    const model = ctx.modelRegistry.find(providerId, modelId);
    if (!model) continue;
    const provider = ctx.modelRegistry.getProvider(providerId) as {
      streamSimple?: (m: unknown, c: unknown, o?: unknown) => { result(): Promise<unknown> };
    } | null;
    if (!provider?.streamSimple) continue;
    return async (prompt: string) => {
      const stream = provider.streamSimple!(model, {
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      });
      return messageText((await stream.result()) as { stopReason?: string; errorMessage?: string; content: unknown });
    };
  }
  return null;
}

export default function extension(pi: ExtensionAPI): void {
  const agentDir = defaultAgentDir();
  const root = pocketRoot(agentDir);
  const sessionsDir = join(agentDir, "sessions");
  const state: ActivationState = { active: false };
  let config = loadConfig(root);

  registerPocketTools(pi, {
    state,
    root,
    sessionsDir,
    maxSessionAgeDays: () => config.distiller.maxSessionAgeDays,
  });

  /** Sync activation with the current model; on activation, ensure the store
   * exists and kick the bounded distiller pass (fire-and-forget — it must
   * never delay or fail the user's session start). */
  function activate(ctx: ExtensionContext): void {
    const becameActive = recomputeActivation(pi, ctx, state, config);
    if (!state.active) return;
    ensureLayout(root);
    if (!becameActive) return;
    const callModel = makeCallModel(ctx, config);
    runDistillerPass(root, sessionsDir, config.distiller, {
      callModel,
      log: (msg) => ctx.ui.notify(msg, "info"),
    })
      .then((result) => {
        if (result.errors.length > 0) {
          ctx.ui.notify(`astral-pocket distiller: ${result.errors.length} session(s) failed`, "warning");
        }
      })
      .catch(() => ctx.ui.notify("astral-pocket distiller pass failed; mechanical floor intact", "warning"));
  }

  pi.on("session_start", (_event, ctx) => {
    activate(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    activate(ctx);
  });

  pi.on("before_agent_start", (event, _ctx) => {
    if (!state.active) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${buildPocketGuidance(readSummaryCapped(root))}` };
  });

  pi.registerCommand("pocket", {
    description: "Toggle the astral pocket: /pocket on|off|status",
    getArgumentCompletions: (prefix) => {
      const items = ["on", "off", "status"].map((v) => ({ value: v, label: v }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const verb = args.trim().toLowerCase();
      if (verb === "on" || verb === "off") {
        config = { ...config, enabled: verb === "on" };
        saveConfig(root, config);
        activate(ctx);
        ctx.ui.notify(
          config.enabled
            ? "Astral pocket enabled (active for gpt-6-astra sessions)."
            : "Astral pocket disabled.",
          "info",
        );
        return;
      }
      const notes = readRegistryLines(root).length;
      ctx.ui.notify(
        [
          `Pocket: ${config.enabled ? "enabled" : "disabled"}; ${state.active ? "active this session" : "inactive (not an astra session)"}`,
          `Notes: ${notes}. Distiller: ${config.distiller.enabled ? `on (model: ${config.distiller.model ?? DISTILLER_MODEL_PREFERENCE[0]})` : "off"}`,
          `Store: ${root}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
