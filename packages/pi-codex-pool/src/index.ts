import { type AuthEvent, type AuthInteraction, type OAuthCredential } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { PoolStore, defaultPoolState } from "./storage.ts";
import { POOL_SENTINEL, PoolRuntime, statusText } from "./runtime.ts";
import { MAX_LABEL_LENGTH, type AccountRecord, type NativeCodexProvider } from "./types.ts";

const STATE_FILE_NAME = "codex-pool.json";
const COMMAND = "codex-pool";

function message(error: unknown): string {
  try { return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 180); }
  catch { return "unknown error"; }
}

function say(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(text, type);
    else console.log(text);
  } catch (error) {
    try { console.error(`[codex-pool] notification failed: ${message(error)}`); } catch { /* teardown */ }
  }
}

function validateLabel(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const label = raw.trim();
  if ([...label].length > MAX_LABEL_LENGTH) throw new Error(`Account labels must be at most ${MAX_LABEL_LENGTH} characters`);
  if (/[\u0000-\u001f\u007f\u001b]/u.test(label) || label.includes("·")) throw new Error("Account labels cannot contain control characters or ·");
  return label;
}

function lookup(accounts: readonly AccountRecord[], reference: string): AccountRecord {
  const value = reference.trim();
  if (!value) throw new Error("Account id or label is required");
  const exact = accounts.find((account) => account.id === value || account.label === value);
  if (exact) return exact;
  const matches = accounts.filter((account) => account.label.startsWith(value));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Account prefix is ambiguous: ${matches.map((account) => account.label).join(", ")}`);
  throw new Error(`Unknown Codex account: ${value}`);
}

function formatAccount(account: AccountRecord, activeId: string | undefined): string {
  const five = account.quota?.fiveHour === null || account.quota?.fiveHour === undefined ? "?" : `${Math.round(account.quota.fiveHour)}%`;
  const weekly = account.quota?.weekly === null || account.quota?.weekly === undefined ? "?" : `${Math.round(account.quota.weekly)}%`;
  return `${account.id} ${account.label}${account.id === activeId ? " (active)" : ""} · 5h ${five} · 7d ${weekly}`;
}

function helpText(): string {
  return [
    "/codex-pool status — show the active account and quota",
    "/codex-pool list — list managed accounts",
    "/codex-pool add [label] — sign in and add an OAuth account",
    "/codex-pool use <id|label> — select an account",
    "/codex-pool remove <id|label> — remove an account and its stored credentials after confirmation. Use --yes in headless mode.",
    "/codex-pool refresh — refresh credentials and quota",
    "/codex-pool threshold <5h> <7d> — set minimum remaining percentages (0–100)",
    "/codex-pool help — show this help",
  ].join("\n");
}

function openAuthUrl(pi: ExtensionAPI, ctx: ExtensionCommandContext, url: string): void {
  say(ctx, `Authorize Codex at: ${url}`);
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  void pi.exec(command, args).catch((error) => {
    try { console.error(`[codex-pool] browser opener failed: ${message(error)}`); } catch { /* teardown */ }
  });
}

export function createAuthInteraction(pi: ExtensionAPI, ctx: ExtensionCommandContext, signal?: AbortSignal): AuthInteraction {
  return {
    signal,
    prompt: async (prompt) => {
      if (!ctx.hasUI) throw new Error("Codex login requires interactive UI");
      if (prompt.type === "select") {
        const selected = await ctx.ui.select(prompt.message, prompt.options.map((option) => option.label), { signal: prompt.signal ?? signal });
        if (selected === undefined) throw new Error("Codex login cancelled");
        return prompt.options.find((option) => option.label === selected)?.id ?? selected;
      }
      const answer = await ctx.ui.input(prompt.message, "placeholder" in prompt ? prompt.placeholder : undefined, { signal: prompt.signal ?? signal });
      if (answer === undefined) throw new Error("Codex login cancelled");
      return answer;
    },
    notify: (event: AuthEvent) => {
      if (event.type === "auth_url") openAuthUrl(pi, ctx, event.url);
      else if (event.type === "progress") say(ctx, event.message);
      else if (event.type === "info") say(ctx, event.message);
      else if (event.type === "device_code") say(ctx, `Codex device code: ${event.userCode} at ${event.verificationUri}`);
    },
  };
}

async function login(runtime: PoolRuntime, pi: ExtensionAPI, ctx: ExtensionCommandContext, signal?: AbortSignal): Promise<OAuthCredential> {
  return runtime.login(createAuthInteraction(pi, ctx, signal));
}

function registerProvider(pi: ExtensionAPI, runtime: PoolRuntime): void {
  if (runtime.hasAccounts()) pi.registerProvider(runtime.provider());
}

function nativeCodexProvider(ctx: ExtensionContext): NativeCodexProvider | undefined {
  return ctx.modelRegistry.getProvider("openai-codex") as NativeCodexProvider | undefined;
}

async function handleCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI, runtime: PoolRuntime): Promise<void> {
  const parts = args.trim().split(/\s+/u).filter(Boolean);
  const action = (parts.shift() ?? "status").toLowerCase();
  try {
    if (action === "help") { say(ctx, helpText()); return; }
    if (action === "status") {
      say(ctx, statusText(runtime.snapshot) ?? "No Codex accounts are managed.");
      return;
    }
    if (action === "list") {
      const state = runtime.snapshot;
      say(ctx, state.accounts.length === 0 ? "No Codex accounts are managed." : state.accounts.map((account) => formatAccount(account, state.activeAccountId)).join("\n"));
      return;
    }
    if (action === "add") {
      if (!ctx.hasUI) throw new Error("Codex login requires interactive UI");
      const label = validateLabel(parts.join(" ") || undefined);
      const credentials = await login(runtime, pi, ctx, ctx.signal);
      const account = await runtime.addAccount(label, credentials);
      registerProvider(pi, runtime);
      try {
        await runtime.refreshAccount(account.id, ctx.signal);
        say(ctx, `Added Codex account ${account.label}`);
      } catch (error) {
        // The account is already persisted. Quota is optional startup metadata,
        // so make the warning explicit instead of reporting a failed add.
        say(ctx, `Added Codex account ${account.label}, but quota refresh failed: ${message(error)}`, "warning");
      }
      return;
    }
    if (action === "use") {
      const account = lookup(runtime.snapshot.accounts, parts.join(" "));
      await runtime.useAccount(account.id);
      registerProvider(pi, runtime);
      say(ctx, `Using Codex account ${account.label}`);
      return;
    }
    if (action === "remove") {
      const yes = parts.at(-1) === "--yes";
      if (yes) parts.pop();
      const account = lookup(runtime.snapshot.accounts, parts.join(" "));
      if (!yes) {
        if (!ctx.hasUI) throw new Error("Removal requires confirmation; pass --yes in headless mode");
        if (!await ctx.ui.confirm("Remove Codex account", `Remove ${account.label}?`)) return;
      }
      await runtime.removeAccount(account.id);
      if (!runtime.hasAccounts()) pi.unregisterProvider("openai-codex");
      say(ctx, `Removed Codex account ${account.label}`);
      return;
    }
    if (action === "refresh") {
      await runtime.refreshAll(ctx.signal);
      say(ctx, "Codex accounts refreshed");
      return;
    }
    if (action === "threshold") {
      if (parts.length !== 2) throw new Error("Usage: /codex-pool threshold <5h> <7d>");
      const values = parts.map(Number);
      if (!values.every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) throw new Error("Thresholds must be numbers from 0 through 100");
      await runtime.setThresholds(values[0], values[1]);
      say(ctx, `Codex thresholds set to ${values[0]}% / ${values[1]}%`);
      return;
    }
    throw new Error(`Unknown action: ${action}. Use /codex-pool help`);
  } catch (error) {
    say(ctx, message(error), "error");
  }
}

export default async function codexPool(pi: ExtensionAPI): Promise<void> {
  let runtime: PoolRuntime | undefined;

  const requireRuntime = (): PoolRuntime => {
    if (!runtime) {
      throw new Error("OpenAI Codex is unavailable in this Pi installation. Update Pi to a version that includes the openai-codex provider.");
    }
    return runtime;
  };

  pi.registerCommand(COMMAND, {
    description: "Manage OpenAI Codex OAuth accounts and quota routing",
    handler: async (args, ctx) => {
      try {
        await handleCommand(args, ctx, pi, requireRuntime());
      } catch (error) {
        say(ctx, message(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Resolve the built-in provider through Pi instead of importing its private
    // module path: standalone packages cannot resolve Pi's nested dependencies.
    const native = nativeCodexProvider(ctx);
    if (!native) return;
    runtime = new PoolRuntime(new PoolStore(join(getAgentDir(), STATE_FILE_NAME)), native);
    await runtime.load();
    registerProvider(pi, runtime);
    runtime.startSession(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await runtime?.refreshActive(ctx.signal);
  });
  pi.on("session_shutdown", async () => {
    runtime?.stopSession();
  });
}

export { defaultPoolState, POOL_SENTINEL };
export { PoolStore, validatePoolState } from "./storage.ts";
export { parseQuotaPayload } from "./quota.ts";
export { selectAccount } from "./selection.ts";
export { statusText, PoolRuntime } from "./runtime.ts";
