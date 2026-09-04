import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type AuthInteraction, type Context, type Model, type OAuthCredential, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultPoolState, PoolStore } from "./storage.ts";
import { selectAccount } from "./selection.ts";
import { createUsageFetcher, type UsageFetcher } from "./quota.ts";
import type { AccountRecord, CodexFullStream, CodexFullStreamOptions, CodexStream, NativeCodexProvider, PoolState, SessionStatusSink } from "./types.ts";

const TOKEN_REFRESH_MARGIN_MS = 60_000;
const POOL_SENTINEL = "codex-pool-managed";
const USAGE_REFRESH_MS = 5 * 60_000;
const USAGE_CONFIRM_TIMEOUT_MS = 5_000;

function describe(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
  } catch {
    return "unknown error";
  }
}

function isMeaningful(event: AssistantMessageEvent): boolean {
  if (event.type === "text_delta" || event.type === "thinking_delta") return event.delta.length > 0;
  if (event.type === "text_end" || event.type === "thinking_end") return event.content.length > 0;
  return event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end";
}

function hasQuotaCode(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasQuotaCode(item));
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "code" || key === "type") && typeof child === "string"
      && /^(?:usage_limit_reached|usage_not_included)$/iu.test(child)) return true;
    if (hasQuotaCode(child)) return true;
  }
  return false;
}

function hasFriendlyUsageLimitPhrase(error: AssistantMessage): boolean {
  const message = error.errorMessage?.trim() ?? "";
  // Pi 0.82 turns every HTTP 429 into this phrase, so the phrase alone is not
  // evidence that the account's quota is exhausted.
  return /^You have hit your ChatGPT usage limit(?:[.!]| \(|$)/iu.test(message);
}

function hasRetainedQuotaCode(error: AssistantMessage): boolean {
  return hasQuotaCode(error) || /(?:^|[\s"':,])(?:usage_limit_reached|usage_not_included)(?:$|[\s"',.])/iu.test(error.errorMessage ?? "");
}

function combineSignals(left: AbortSignal | undefined, right: AbortSignal | undefined): AbortSignal | undefined {
  if (!left) return right;
  if (!right) return left;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([left, right]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  left.addEventListener("abort", abort, { once: true });
  right.addEventListener("abort", abort, { once: true });
  if (left.aborted || right.aborted) controller.abort();
  return controller.signal;
}

export class PoolRuntime {
  private state: PoolState;
  private sessionController: AbortController | undefined;
  private sessionSink: SessionStatusSink | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: PoolStore,
    private readonly native: NativeCodexProvider,
    private readonly usage: UsageFetcher = createUsageFetcher(),
  ) {
    this.state = defaultPoolState();
  }

  get snapshot(): PoolState {
    return this.state;
  }

  get sentinel(): string {
    return POOL_SENTINEL;
  }

  async load(): Promise<PoolState> {
    this.state = await this.store.load();
    return this.state;
  }

  hasAccounts(): boolean {
    return this.state.accounts.length > 0;
  }

  startSession(ctx: ExtensionContext): void {
    this.stopSession();
    const controller = new AbortController();
    this.sessionController = controller;
    let active = true;
    this.sessionSink = {
      publish: (state) => {
        if (!active) return;
        try {
          ctx.ui.setStatus("codex-pool", statusText(state));
        } catch (error) {
          log(`[codex-pool] status update failed: ${describe(error)}`);
        }
      },
      revoke: () => { active = false; },
    };
    this.publish();
    this.refreshAll(controller.signal).catch((error) => log(`[codex-pool] startup refresh failed: ${describe(error)}`));
    this.refreshTimer = setInterval(() => {
      this.refreshAll(controller.signal).catch((error) => log(`[codex-pool] scheduled refresh failed: ${describe(error)}`));
    }, USAGE_REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  stopSession(): void {
    this.sessionSink?.revoke();
    this.sessionSink = undefined;
    this.sessionController?.abort();
    this.sessionController = undefined;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  async refreshActive(signal?: AbortSignal): Promise<void> {
    const id = this.state.activeAccountId;
    if (!id) return;
    try {
      await this.refreshAccount(id, signal);
    } catch (error) {
      log(`[codex-pool] active refresh failed: ${describe(error)}`);
    }
    this.publish();
  }

  async refreshAll(signal?: AbortSignal): Promise<void> {
    const accounts = [...this.state.accounts];
    await Promise.all(accounts.map(async (account) => {
      try {
        await this.refreshAccount(account.id, signal);
      } catch (error) {
        log(`[codex-pool] refresh ${account.id} failed: ${describe(error)}`);
      }
    }));
    this.publish();
  }

  async refreshAccount(id: string, signal?: AbortSignal): Promise<void> {
    const account = await this.refreshCredential(id, signal);
    try {
      const quota = await this.usage(account.credentials.access, signal);
      this.state = await this.store.mutate((state) => {
        const current = state.accounts.find((candidate) => candidate.id === id);
        if (!current) return state;
        if (!current.quota || quota.capturedAt > current.quota.capturedAt) current.quota = quota;
        current.quotaFailed = false;
        delete current.lastError;
        return state;
      });
    } catch (error) {
      // Cancellation is session control flow, not an account health failure.
      if (signal?.aborted) throw error;
      const diagnostic = describe(error);
      this.state = await this.store.mutate((state) => {
        const current = state.accounts.find((candidate) => candidate.id === id);
        if (current) current.lastError = diagnostic;
        return state;
      });
      throw error;
    }
    this.publish();
  }

  async refreshCredential(id: string, signal?: AbortSignal): Promise<AccountRecord> {
    const current = this.state.accounts.find((candidate) => candidate.id === id);
    if (!current) throw new Error("Codex account not found");
    // Fresh credentials need no cross-process coordination. The lock is only
    // needed for an imminent refresh, where another process could rotate the
    // refresh token between our optimistic check and the native refresh.
    if (current.credentials.expires > Date.now() + TOKEN_REFRESH_MARGIN_MS) return current;

    if (!this.native.auth.oauth) throw new Error("Native Codex OAuth is unavailable");
    this.state = await this.store.mutate(async (state) => {
      const account = state.accounts.find((candidate) => candidate.id === id);
      if (!account) throw new Error("Codex account not found");
      if (account.credentials.expires > Date.now() + TOKEN_REFRESH_MARGIN_MS) return state;
      account.credentials = await this.native.auth.oauth!.refresh(account.credentials, signal);
      return state;
    });
    this.publish();
    const account = this.state.accounts.find((candidate) => candidate.id === id);
    if (!account) throw new Error("Codex account not found");
    return account;
  }

  async login(interaction: AuthInteraction): Promise<OAuthCredential> {
    if (!this.native.auth.oauth) throw new Error("Native Codex OAuth is unavailable");
    return this.native.auth.oauth.login(interaction);
  }

  async addAccount(label: string | undefined, credentials: OAuthCredential): Promise<AccountRecord> {
    const providerAccountId = accountIdFromToken(credentials.access);
    const id = accountIdHash(providerAccountId);
    const nextLabel = label ?? defaultLabel(id);
    this.state = await this.store.mutate((state) => {
      if (state.accounts.some((account) => account.id === id || account.providerAccountId === providerAccountId)) {
        throw new Error("That Codex account is already managed");
      }
      if (state.accounts.some((account) => account.label === nextLabel)) {
        throw new Error("That Codex account label is already in use");
      }
      state.accounts.push({ id, label: nextLabel, providerAccountId, credentials });
      state.activeAccountId ??= id;
      return state;
    });
    this.publish();
    return this.state.accounts.find((account) => account.id === id)!;
  }

  async useAccount(id: string): Promise<void> {
    this.state = await this.store.mutate((state) => {
      if (!state.accounts.some((account) => account.id === id)) throw new Error("Codex account not found");
      state.activeAccountId = id;
      return state;
    });
    this.publish();
  }

  async removeAccount(id: string): Promise<void> {
    this.state = await this.store.mutate((state) => {
      const index = state.accounts.findIndex((account) => account.id === id);
      if (index < 0) throw new Error("Codex account not found");
      state.accounts.splice(index, 1);
      if (state.activeAccountId === id) state.activeAccountId = state.accounts[0]?.id;
      return state;
    });
    this.publish();
  }

  async setThresholds(fiveHour: number, weekly: number): Promise<void> {
    this.state = await this.store.mutate((state) => {
      state.thresholds = { fiveHour, weekly };
      return state;
    });
    this.publish();
  }

  streamSimple(model: Model<"openai-codex-responses">, context: Context, options?: SimpleStreamOptions): ReturnType<CodexStream> {
    return this.route(model, context, options, this.native.streamSimple as CodexStream);
  }

  stream(model: Model<"openai-codex-responses">, context: Context, options?: CodexFullStreamOptions): ReturnType<CodexFullStream> {
    return this.route(model, context, options as SimpleStreamOptions, this.native.stream as unknown as CodexStream);
  }

  private route(model: Model<"openai-codex-responses">, context: Context, options: SimpleStreamOptions | undefined, nativeStream: CodexStream) {
    const output = createAssistantMessageEventStream();
    void this.runRoute(output, model, context, options, nativeStream).catch((error) => {
      output.push(makeErrorEvent(model, error, options?.signal?.aborted || this.sessionController?.signal.aborted === true));
      output.end();
      log(`[codex-pool] stream routing failed: ${describe(error)}`);
    });
    return output;
  }

  private async runRoute(output: ReturnType<typeof createAssistantMessageEventStream>, model: Model<"openai-codex-responses">, context: Context, options: SimpleStreamOptions | undefined, nativeStream: CodexStream): Promise<void> {
    const attempted = new Set<string>();
    let lastError: AssistantMessageEvent | undefined;
    for (;;) {
      if (options?.signal?.aborted || this.sessionController?.signal.aborted) throw new Error("Request was aborted");
      const selected = await this.chooseAccount(attempted);
      if (!selected) {
        if (lastError) {
          output.push(lastError);
          output.end();
          return;
        }
        throw new Error("No usable Codex account is available");
      }
      attempted.add(selected.id);
      const signal = combineSignals(options?.signal, this.sessionController?.signal);
      const account = await this.refreshCredential(selected.id, signal);
      const delegatedOptions = {
        ...options,
        apiKey: account.credentials.access,
        ...(options?.sessionId === undefined ? {} : { sessionId: scopedSessionId(account.id, options.sessionId) }),
        ...(signal ? { signal } : {}),
      };
      const native = nativeStream(model, context, delegatedOptions);
      const buffered: AssistantMessageEvent[] = [];
      let meaningful = false;
      let retry = false;
      for await (const event of native) {
        if (event.type === "error") {
          lastError = event;
          const canRetry = !meaningful
            && !options?.signal?.aborted
            && !this.sessionController?.signal.aborted;
          const quotaFailure = canRetry && (
            hasRetainedQuotaCode(event.error)
            || (hasFriendlyUsageLimitPhrase(event.error) && await this.confirmQuotaExhausted(account, signal))
          );
          if (quotaFailure) {
            await this.markQuotaFailed(account.id, event.error.errorMessage);
            retry = true;
            break;
          }
          if (!meaningful) for (const pending of buffered.splice(0)) output.push(pending);
          output.push(event);
          output.end();
          return;
        }
        if (meaningful) {
          output.push(event);
          continue;
        }
        if (isMeaningful(event)) {
          meaningful = true;
          for (const pending of buffered.splice(0)) output.push(pending);
          output.push(event);
          continue;
        }
        // Structural events before the first meaningful delta are retained so
        // a retry can discard them, including empty text/thinking end events.
        buffered.push(event);
      }
      if (retry) continue;
      for (const pending of buffered) output.push(pending);
      output.end();
      return;
    }
  }

  private async confirmQuotaExhausted(account: AccountRecord, signal: AbortSignal | undefined): Promise<boolean> {
    const timeout = AbortSignal.timeout(USAGE_CONFIRM_TIMEOUT_MS);
    const boundedSignal = combineSignals(signal, timeout);
    try {
      const quota = await this.usage(account.credentials.access, boundedSignal);
      this.state = {
        ...this.state,
        accounts: this.state.accounts.map((candidate) => candidate.id === account.id
          ? { ...candidate, quota, quotaFailed: undefined, lastError: undefined }
          : candidate),
      };
      this.publish();
      return quota.fiveHour === 0 || quota.weekly === 0;
    } catch {
      // A failed or timed-out confirmation is not quota evidence. Forward the
      // original 429 rather than turning an unavailable diagnostic into failover.
      return false;
    }
  }

  private async chooseAccount(excludedIds: ReadonlySet<string>): Promise<AccountRecord | undefined> {
    const selected = selectAccount(this.state, excludedIds);
    if (!selected || selected.id === this.state.activeAccountId) return selected;

    // Persist automatic failover so the footer and the next request agree on
    // the sticky account. A lock failure must not turn a usable request into a
    // hard failure; retain the local selection and retry persistence later.
    try {
      this.state = await this.store.mutate((state) => {
        if (state.accounts.some((account) => account.id === selected.id)) state.activeAccountId = selected.id;
        return state;
      });
    } catch (error) {
      log(`[codex-pool] could not persist selected account: ${describe(error)}`);
      this.state.activeAccountId = selected.id;
    }
    this.publish();
    return this.state.accounts.find((account) => account.id === selected.id) ?? selected;
  }

  private async markQuotaFailed(id: string, diagnostic: string | undefined): Promise<void> {
    this.state = {
      ...this.state,
      accounts: this.state.accounts.map((account) => account.id === id
        ? { ...account, quotaFailed: true, lastError: describe(diagnostic ?? "quota limit") }
        : account),
    };
    this.publish();
    try {
      this.state = await this.store.mutate((state) => {
        const account = state.accounts.find((candidate) => candidate.id === id);
        if (account) {
          account.quotaFailed = true;
          account.lastError = describe(diagnostic ?? "quota limit");
        }
        return state;
      });
    } catch {
      // The current request already has a local health decision. A busy lock
      // must not turn that decision into a failed request or block failover.
      log("[codex-pool] could not persist quota failure; continuing with local state");
    }
    this.publish();
  }

  private publish(): void {
    this.sessionSink?.publish(this.state);
  }

  provider(): NativeCodexProvider {
    const runtime = this;
    const nativeOAuth = this.native.auth.oauth;
    const oauth = nativeOAuth ? {
      name: "Codex account pool",
      async login(): Promise<OAuthCredential> {
        throw new Error("Use /codex-pool add to manage Codex accounts");
      },
      // Models resolves stored OAuth credentials through this bridge. It must
      // never refresh or replace the user's private native credential here.
      async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
        return credential;
      },
      async toAuth(): Promise<{ apiKey: string }> {
        return { apiKey: POOL_SENTINEL };
      },
    } : undefined;
    return {
      ...this.native,
      auth: {
        apiKey: {
          name: "Codex account pool",
          async resolve() {
            return runtime.hasAccounts() ? { auth: { apiKey: POOL_SENTINEL }, source: "Codex account pool" } : undefined;
          },
        },
        ...(oauth ? { oauth } : {}),
      },
      streamSimple: (model, context, options) => this.streamSimple(model, context, options),
      stream: (model, context, options) => this.stream(model, context, options),
    } as NativeCodexProvider;
  }
}

function makeErrorEvent(model: Model<"openai-codex-responses">, error: unknown, aborted: boolean): AssistantMessageEvent {
  const reason: "aborted" | "error" = aborted ? "aborted" : "error";
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: reason,
    errorMessage: describe(error),
    timestamp: Date.now(),
  };
  return { type: "error", reason, error: assistant };
}

export function statusText(state: PoolState): string | undefined {
  const account = state.accounts.find((candidate) => candidate.id === state.activeAccountId) ?? state.accounts[0];
  if (!account) return undefined;
  return `codex ${account.label} · 5h ${account.quota?.fiveHour === null || account.quota?.fiveHour === undefined ? "?" : Math.round(account.quota.fiveHour)}% · 7d ${account.quota?.weekly === null || account.quota?.weekly === undefined ? "?" : Math.round(account.quota.weekly)}%`;
}

function accountIdFromToken(token: string): string {
  try {
    const payload = token.split(".")[1];
    if (!payload) throw new Error("missing token payload");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = decoded["https://api.openai.com/auth"];
    const id = auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
    if (typeof id !== "string" || !id) throw new Error("missing account id");
    return id;
  } catch {
    throw new Error("Could not determine the Codex account id from the OAuth token");
  }
}

function accountIdHash(value: string): string {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(value)) hash = Math.imul(hash ^ byte, 16777619);
  return `acct-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function defaultLabel(id: string): string {
  // The label mirrors the unique managed id, avoiding account metadata in the footer.
  return `account-${id.replace(/^acct-/u, "")}`;
}

function scopedSessionId(accountId: string, sessionId: string): string {
  // Pi 0.82 keys its native Codex WebSocket cache only by sessionId. Include
  // the stable managed id so the same caller session cannot share a socket or
  // continuation across OAuth accounts.
  return `codex-pool:${accountId}:${sessionId}`;
}

function log(message: string): void {
  try { console.error(message); } catch { /* teardown */ }
}

export { POOL_SENTINEL };
