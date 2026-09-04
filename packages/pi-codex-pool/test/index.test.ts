import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createModels, createAssistantMessageEventStream, type AssistantMessageEvent, type CredentialStore, type OAuthCredential } from "@earendil-works/pi-ai";
import codexPool, { createAuthInteraction, PoolRuntime, statusText } from "../src/index.ts";
import { POOL_SENTINEL } from "../src/runtime.ts";
import { parseQuotaPayload } from "../src/quota.ts";
import { selectAccount } from "../src/selection.ts";
import { PoolStore, validatePoolState } from "../src/storage.ts";
import type { CodexFullStreamOptions, NativeCodexProvider, PoolState } from "../src/types.ts";

class CountingStore extends PoolStore {
  mutateCalls = 0;
  failMutations = false;

  override async mutate(mutator: Parameters<PoolStore["mutate"]>[0]): Promise<PoolState> {
    this.mutateCalls++;
    if (this.failMutations) throw new Error("lock busy");
    return super.mutate(mutator);
  }
}

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function token(account: string, suffix = "access"): string {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url");
  return `header.${payload}.${suffix}`;
}

function credentials(account: string, expires = Date.now() + 3_600_000): OAuthCredential {
  return { type: "oauth", refresh: `refresh-${account}`, access: token(account), expires };
}

async function storePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-pool-test-"));
  temporary.push(directory);
  return join(directory, "codex-pool.json");
}

function native(
  streamSimple: NativeCodexProvider["streamSimple"],
  refresh?: NativeCodexProvider["auth"]["oauth"],
  stream: NativeCodexProvider["stream"] = streamSimple as NativeCodexProvider["stream"],
): NativeCodexProvider {
  return {
    id: "openai-codex",
    name: "OpenAI Codex",
    models: undefined,
    getModels: () => [],
    stream,
    streamSimple,
    auth: { oauth: refresh },
  } as unknown as NativeCodexProvider;
}

function model(): Parameters<NativeCodexProvider["streamSimple"]>[0] {
  return { provider: "openai-codex", api: "openai-codex-responses", id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as never;
}

async function events(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const result: AssistantMessageEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

describe("Codex pool storage", () => {
  test("loads malformed state as an empty pool without exposing file contents", async () => {
    const path = await storePath();
    const store = new PoolStore(path);
    await expect(store.load()).resolves.toEqual({ accounts: [], thresholds: { fiveHour: 10, weekly: 10 } });
    expect(() => validatePoolState({ accounts: [], thresholds: { fiveHour: "secret", weekly: 10 } })).toThrow("thresholds");
    expect(() => validatePoolState({ accounts: [{ id: "a", label: "A", providerAccountId: "A", credentials: credentials("A"), quota: { fiveHour: 101, weekly: 50, capturedAt: 1 } }], thresholds: { fiveHour: 10, weekly: 10 } })).toThrow("account");
  });

  test("redacts credential text from malformed JSON diagnostics", async () => {
    const path = await storePath();
    const secret = "fake-malformed-oauth-secret";
    await writeFile(path, `{ "credentials": "${secret}", {`, { mode: 0o600 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(new PoolStore(path).load()).resolves.toEqual({ accounts: [], thresholds: { fiveHour: 10, weekly: 10 } });
      await expect(new PoolStore(path).mutate((state) => state)).rejects.toThrow("invalid Codex pool JSON");
      expect(errorSpy.mock.calls.flat().join(" ")).not.toContain(secret);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("recovers a stale crashed-process lock with an atomic takeover", async () => {
    const path = await storePath();
    const lockPath = `${path}.lock`;
    await mkdir(lockPath, { mode: 0o700 });
    const token = "stale-token";
    const ownerPath = join(lockPath, `owner-${token}`);
    const heartbeatPath = join(lockPath, `heartbeat-${token}`);
    await writeFile(ownerPath, `${token}\n`, { mode: 0o600 });
    await writeFile(heartbeatPath, `${token}\n`, { mode: 0o600 });
    const staleTime = (Date.now() - 60_000) / 1000;
    await utimes(heartbeatPath, staleTime, staleTime);
    await expect(new PoolStore(path).mutate((state) => state)).resolves.toEqual({ accounts: [], thresholds: { fiveHour: 10, weekly: 10 } });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a former owner cannot overwrite or release a successor after takeover", async () => {
    const path = await storePath();
    const store = new PoolStore(path);
    let resume!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const resumePromise = new Promise<void>((resolve) => { resume = resolve; });
    const former = store.mutate(async (state) => {
      entered();
      await resumePromise;
      state.thresholds.fiveHour = 25;
      return state;
    });
    await enteredPromise;
    const lockPath = `${path}.lock`;
    const owner = (await readdir(lockPath)).find((entry) => entry.startsWith("owner-"));
    expect(owner).toBeDefined();
    const quarantine = `${lockPath}.takeover-test`;
    await rename(lockPath, quarantine);
    await rm(quarantine, { recursive: true, force: true });
    const successor = "successor-token";
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(join(lockPath, `owner-${successor}`), `${successor}\n`, { mode: 0o600 });
    await writeFile(join(lockPath, `heartbeat-${successor}`), `${successor}\n`, { mode: 0o600 });
    resume();
    await expect(former).rejects.toThrow("ownership was lost");
    await expect(readFile(join(lockPath, `owner-${successor}`), "utf8")).resolves.toBe(`${successor}\n`);
  });

  test("serializes concurrent read-modify-write mutations and writes private atomic state", async () => {
    const path = await storePath();
    const store = new PoolStore(path);
    await Promise.all(Array.from({ length: 8 }, (_, index) => store.mutate((state) => {
      state.accounts.push({ id: `id-${index}`, label: `label-${index}`, providerAccountId: `provider-${index}`, credentials: credentials(`account-${index}`) });
      return state;
    })));
    const saved = JSON.parse(await readFile(path, "utf8")) as PoolState;
    expect(saved.accounts).toHaveLength(8);
    expect(saved.accounts.map((account) => account.id).sort()).toEqual(Array.from({ length: 8 }, (_, index) => `id-${index}`));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
  });
});

describe("quota and selection", () => {
  test("recognizes only the observed five-hour and weekly windows", () => {
    expect(parseQuotaPayload({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 }, secondary_window: { used_percent: 80, limit_window_seconds: 604800 }, extra: { used_percent: 1, limit_window_seconds: 60 } } }, 42)).toEqual({ fiveHour: 75, weekly: 20, capturedAt: 42 });
    expect(parseQuotaPayload({ window: { used_percent: 4, limit_window_seconds: 3600 } }, 42)).toEqual({ fiveHour: null, weekly: null, capturedAt: 42 });
  });

  test("keeps a healthy or unknown active account sticky and switches below threshold", () => {
    const state: PoolState = {
      activeAccountId: "a",
      thresholds: { fiveHour: 10, weekly: 10 },
      accounts: [
        { id: "a", label: "A", providerAccountId: "A", credentials: credentials("A"), quota: { fiveHour: null, weekly: 4, capturedAt: 1 } },
        { id: "b", label: "B", providerAccountId: "B", credentials: credentials("B"), quota: { fiveHour: 60, weekly: 40, capturedAt: 1 } },
      ],
    };
    expect(selectAccount(state)?.id).toBe("b");
    state.accounts[0].quota = { fiveHour: null, weekly: 40, capturedAt: 2 };
    expect(selectAccount(state)?.id).toBe("a");
    state.accounts[0].quota = { fiveHour: 5, weekly: 40, capturedAt: 3 };
    expect(selectAccount(state)?.id).toBe("b");
  });

  test("selects the best known account even when every account is below threshold", () => {
    const state: PoolState = {
      thresholds: { fiveHour: 50, weekly: 50 },
      accounts: [
        { id: "a", label: "A", providerAccountId: "A", credentials: credentials("A"), quota: { fiveHour: 20, weekly: 80, capturedAt: 1 } },
        { id: "b", label: "B", providerAccountId: "B", credentials: credentials("B"), quota: { fiveHour: 30, weekly: 30, capturedAt: 1 } },
      ],
    };
    expect(selectAccount(state)?.id).toBe("b");
  });
});

describe("stream routing and auth", () => {
  test("refreshes native OAuth under the store seam and updates quota", async () => {
    const path = await storePath();
    let refreshed = "";
    const refresh = {
      name: "Codex",
      login: async () => credentials("A"),
      refresh: async (current: OAuthCredential) => { refreshed = current.refresh; return credentials("A", Date.now() + 3_600_000); },
      toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
    };
    const runtime = new PoolRuntime(new PoolStore(path), native(() => createAssistantMessageEventStream(), refresh), async (access) => ({ fiveHour: 80, weekly: 70, capturedAt: Date.now() }));
    await runtime.load();
    await runtime.addAccount("A", credentials("A", 0));
    const account = runtime.snapshot.accounts[0];
    await runtime.refreshAccount(account.id);
    expect(refreshed).toBe("refresh-A");
    expect(runtime.snapshot.accounts[0].quota?.fiveHour).toBe(80);
  });

  test("refreshes credentials at the request boundary without locking fresh requests", async () => {
    const path = await storePath();
    let refreshCalls = 0;
    const refresh = {
      name: "Codex",
      login: async () => credentials("A"),
      refresh: async () => { refreshCalls++; return credentials("A"); },
      toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
    };
    const streamSimple = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    };
    const store = new CountingStore(path);
    const runtime = new PoolRuntime(store, native(streamSimple, refresh));
    await runtime.load();
    await runtime.addAccount("A", credentials("A"));
    const afterAdd = store.mutateCalls;
    await events(runtime.streamSimple(model(), { messages: [] }));
    expect(store.mutateCalls).toBe(afterAdd);
    expect(refreshCalls).toBe(0);

    runtime.snapshot.accounts[0].credentials.expires = 0;
    await store.mutate((state) => {
      state.accounts[0].credentials.expires = 0;
      return state;
    });
    await events(runtime.streamSimple(model(), { messages: [] }));
    expect(store.mutateCalls).toBeGreaterThan(afterAdd);
    expect(refreshCalls).toBe(1);
  });

  test("retries one pre-output hard quota failure and preserves event order", async () => {
    const path = await storePath();
    const calls: string[] = [];
    const streamSimple = (_model: never, _context: never, options?: { apiKey?: string }) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        calls.push(options?.apiKey ?? "");
        const partial = {} as never;
        stream.push({ type: "start", partial });
        if (options?.apiKey?.endsWith("A")) stream.push({ type: "error", reason: "error", error: { errorMessage: "usage_limit_reached" } as never });
        else {
          stream.push({ type: "text_start", contentIndex: 0, partial });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial });
          stream.push({ type: "done", reason: "stop", message: partial });
        }
        stream.end();
      });
      return stream;
    };
    const runtime = new PoolRuntime(new PoolStore(path), native(streamSimple as never), async () => ({ fiveHour: 80, weekly: 80, capturedAt: Date.now() }));
    await runtime.load();
    await runtime.addAccount("A", { ...credentials("A"), access: token("A", "A") });
    await runtime.addAccount("B", { ...credentials("B"), access: token("B", "B") });
    const received = await events(runtime.streamSimple(model(), { messages: [] }));
    expect(received.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "done"]);
    expect(calls).toHaveLength(2);
    expect(runtime.snapshot.activeAccountId).toBe(runtime.snapshot.accounts.find((account) => account.label === "B")?.id);
  });

  test("scopes the native WebSocket session cache by account", async () => {
    const path = await storePath();
    const calls: Array<{ apiKey?: string; sessionId?: string }> = [];
    const streamSimple = (_model: never, _context: never, options?: { apiKey?: string; sessionId?: string }) => {
      calls.push({ apiKey: options?.apiKey, sessionId: options?.sessionId });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (options?.apiKey?.endsWith("A")) {
          stream.push({ type: "error", reason: "error", error: { errorMessage: "usage_limit_reached" } as never });
        } else stream.end();
      });
      return stream;
    };
    const runtime = new PoolRuntime(new PoolStore(path), native(streamSimple as never));
    await runtime.load();
    const accountA = await runtime.addAccount("A", { ...credentials("A"), access: token("A", "A") });
    const accountB = await runtime.addAccount("B", { ...credentials("B"), access: token("B", "B") });
    await events(runtime.streamSimple(model(), { messages: [] }, { sessionId: "caller-session" }));
    expect(calls.map((call) => call.sessionId)).toEqual([
      `codex-pool:${accountA.id}:caller-session`,
      `codex-pool:${accountB.id}:caller-session`,
    ]);
    expect(calls[0].sessionId).not.toBe(calls[1].sessionId);
  });

  test("does not fail over from Pi's generic friendly 429 without quota confirmation", async () => {
    const path = await storePath();
    let calls = 0;
    let usageCalls = 0;
    const streamSimple = () => {
      calls++;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: {} as never });
        stream.push({ type: "error", reason: "error", error: { errorMessage: "You have hit your ChatGPT usage limit." } as never });
        stream.end();
      });
      return stream;
    };
    const runtime = new PoolRuntime(new PoolStore(path), native(streamSimple as never), async () => {
      usageCalls++;
      return { fiveHour: 35, weekly: 75, capturedAt: Date.now() };
    });
    await runtime.load();
    await runtime.addAccount("A", credentials("A"));
    await runtime.addAccount("B", credentials("B"));
    const received = await events(runtime.streamSimple(model(), { messages: [] }));
    expect(received.map((event) => event.type)).toEqual(["start", "error"]);
    expect(calls).toBe(1);
    expect(usageCalls).toBe(1);
  });

  test("fails over from a friendly 429 only after a usage window confirms exhaustion", async () => {
    const path = await storePath();
    const calls: string[] = [];
    const streamSimple = (_model: never, _context: never, options?: { apiKey?: string }) => {
      calls.push(options?.apiKey ?? "");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (options?.apiKey?.endsWith("A")) {
          stream.push({ type: "error", reason: "error", error: { errorMessage: "You have hit your ChatGPT usage limit." } as never });
        } else {
          stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: {} as never });
          stream.push({ type: "done", reason: "stop", message: {} as never });
        }
        stream.end();
      });
      return stream;
    };
    const runtime = new PoolRuntime(new PoolStore(path), native(streamSimple as never), async (access) => ({
      fiveHour: access.endsWith("A") ? 0 : 80,
      weekly: 80,
      capturedAt: Date.now(),
    }));
    await runtime.load();
    await runtime.addAccount("A", { ...credentials("A"), access: token("A", "A") });
    await runtime.addAccount("B", { ...credentials("B"), access: token("B", "B") });
    const received = await events(runtime.streamSimple(model(), { messages: [] }));
    expect(received.map((event) => event.type)).toEqual(["text_delta", "done"]);
    expect(calls).toHaveLength(2);
  });

  test("buffers empty structural ends so a pre-output quota retry emits only the winning stream", async () => {
    const path = await storePath();
    const calls: string[] = [];
    const streamSimple = (_model: never, _context: never, options?: { apiKey?: string }) => {
      calls.push(options?.apiKey ?? "");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (options?.apiKey?.endsWith("A")) {
          stream.push({ type: "start", partial: {} as never });
          stream.push({ type: "text_start", contentIndex: 0, partial: {} as never });
          stream.push({ type: "text_end", contentIndex: 0, content: "", partial: {} as never });
          stream.push({ type: "error", reason: "error", error: { errorMessage: "usage_limit_reached" } as never });
        } else {
          stream.push({ type: "start", partial: {} as never });
          stream.push({ type: "text_start", contentIndex: 0, partial: {} as never });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: {} as never });
          stream.push({ type: "done", reason: "stop", message: {} as never });
        }
        stream.end();
      });
      return stream;
    };
    const runtime = new PoolRuntime(new PoolStore(path), native(streamSimple as never));
    await runtime.load();
    await runtime.addAccount("A", { ...credentials("A"), access: token("A", "A") });
    await runtime.addAccount("B", { ...credentials("B"), access: token("B", "B") });
    const received = await events(runtime.streamSimple(model(), { messages: [] }));
    expect(received.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "done"]);
    expect(calls).toHaveLength(2);
  });

  test("does not retry a generic quota or billing phrase", async () => {
    const path = await storePath();
    let calls = 0;
    const streamSimple = () => {
      calls++;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: {} as never });
        stream.push({ type: "error", reason: "error", error: { errorMessage: "quota exceeded; billing issue" } as never });
        stream.end();
      });
      return stream;
    };
    const runtime = new PoolRuntime(new PoolStore(path), native(streamSimple as never));
    await runtime.load();
    await runtime.addAccount("A", credentials("A"));
    await runtime.addAccount("B", credentials("B"));
    const received = await events(runtime.streamSimple(model(), { messages: [] }));
    expect(received.map((event) => event.type)).toEqual(["start", "error"]);
    expect(calls).toBe(1);
  });

  test("continues failover when quota-failure persistence cannot acquire the lock", async () => {
    const path = await storePath();
    const store = new CountingStore(path);
    const calls: string[] = [];
    const streamSimple = (_model: never, _context: never, options?: { apiKey?: string }) => {
      calls.push(options?.apiKey ?? "");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (options?.apiKey?.endsWith("A")) stream.push({ type: "error", reason: "error", error: { errorMessage: "usage_limit_reached" } as never });
        else stream.push({ type: "done", reason: "stop", message: {} as never });
        stream.end();
      });
      return stream;
    };
    const runtime = new PoolRuntime(store, native(streamSimple as never));
    await runtime.load();
    await runtime.addAccount("A", { ...credentials("A"), access: token("A", "A") });
    await runtime.addAccount("B", { ...credentials("B"), access: token("B", "B") });
    store.failMutations = true;
    await events(runtime.streamSimple(model(), { messages: [] }));
    expect(calls).toHaveLength(2);
    expect(runtime.snapshot.accounts.find((account) => account.label === "A")?.quotaFailed).toBe(true);
  });

  test("does not retry or confirm quota after meaningful output or cancellation", async () => {
    const path = await storePath();
    let calls = 0;
    let usageCalls = 0;
    const streamSimple = () => {
      calls++;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial = {} as never;
        stream.push({ type: "start", partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "seen", partial });
        stream.push({ type: "error", reason: "error", error: { errorMessage: "You have hit your ChatGPT usage limit." } as never });
        stream.end();
      });
      return stream;
    };
    const runtime = new PoolRuntime(new PoolStore(path), native(streamSimple as never), async () => {
      usageCalls++;
      return { fiveHour: 0, weekly: 0, capturedAt: Date.now() };
    });
    await runtime.load();
    await runtime.addAccount("A", { ...credentials("A"), access: token("A", "A") });
    await runtime.addAccount("B", { ...credentials("B"), access: token("B", "B") });
    const received = await events(runtime.streamSimple(model(), { messages: [] }));
    expect(received.map((event) => event.type)).toEqual(["start", "text_delta", "error"]);
    expect(calls).toBe(1);
    expect(usageCalls).toBe(0);

    const controller = new AbortController();
    controller.abort();
    await events(runtime.streamSimple(model(), { messages: [] }, { signal: controller.signal }));
    expect(calls).toBe(1);
    expect(usageCalls).toBe(0);
  });
});

describe("commands, status, and lifecycle", () => {
  test("maps native OAuth select prompts to ids and preserves text prompts", async () => {
    const inputs: string[] = [];
    const selections: string[][] = [];
    const interaction = createAuthInteraction({ exec: async () => ({}) } as never, {
      hasUI: true,
      ui: {
        input: async (prompt: string) => { inputs.push(prompt); return "manual-code"; },
        select: async (_prompt: string, options: string[]) => { selections.push(options); return options[1]; },
        notify: () => {},
      },
    } as never);
    await expect(interaction.prompt({ type: "select", message: "Account", options: [{ id: "work", label: "Work" }, { id: "personal", label: "Personal" }] })).resolves.toBe("personal");
    await expect(interaction.prompt({ type: "manual_code", message: "Code", placeholder: "paste" })).resolves.toBe("manual-code");
    expect(selections).toEqual([["Work", "Personal"]]);
    expect(inputs).toEqual(["Code"]);
  });

  test("registers one command family and persists threshold changes", async () => {
    const path = await storePath();
    const directory = path.slice(0, path.lastIndexOf("/"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
    const notifications: string[] = [];
    try {
      const pi = {
        registerProvider: () => {},
        unregisterProvider: () => {},
        registerCommand: (name: string, definition: { handler: (args: string, ctx: never) => Promise<void> }) => commands.set(name, definition),
        on: () => {},
      };
      await codexPool(pi as never);
      expect([...commands.keys()]).toEqual(["codex-pool"]);
      await commands.get("codex-pool")!.handler("threshold 20 30", { hasUI: true, ui: { notify: (text: string) => notifications.push(text) } } as never);
      expect(notifications).toContain("Codex thresholds set to 20% / 30%");
      await expect(new PoolStore(path).load()).resolves.toMatchObject({ thresholds: { fiveHour: 20, weekly: 30 } });
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("publishes bounded status text with unknown windows", () => {
    expect(statusText({ activeAccountId: "a", thresholds: { fiveHour: 10, weekly: 10 }, accounts: [{ id: "a", label: "work", providerAccountId: "secret", credentials: credentials("A") }] })).toBe("codex work · 5h ?% · 7d ?%");
  });

  test("resolves expired stored OAuth through the pool bridge without refreshing or changing it", async () => {
    const path = await storePath();
    const stored = credentials("stored", Date.now() - 1);
    let nativeRefreshCalls = 0;
    const refresh = {
      name: "Native Codex",
      login: async () => credentials("native"),
      refresh: async (credential: OAuthCredential) => { nativeRefreshCalls++; return credential; },
      toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
    };
    const runtime = new PoolRuntime(new PoolStore(path), native(() => createAssistantMessageEventStream(), refresh));
    await runtime.load();
    await runtime.addAccount("managed", credentials("managed"));

    let current: OAuthCredential | undefined = stored;
    const credentialStore: CredentialStore = {
      read: async () => current,
      list: async () => [{ providerId: "openai-codex", type: "oauth" }],
      modify: async (_provider, fn) => {
        const next = await fn(current);
        if (next !== undefined) current = next as OAuthCredential;
        return current;
      },
      delete: async () => { current = undefined; },
    };
    const models = createModels({ credentials: credentialStore });
    const provider = runtime.provider();
    models.setProvider(provider);
    await expect(models.getAuth("openai-codex")).resolves.toEqual({ auth: { apiKey: POOL_SENTINEL }, source: "OAuth" });
    expect(current).toEqual(stored);
    expect(nativeRefreshCalls).toBe(0);
    await expect(provider.auth.oauth!.login({} as never)).rejects.toThrow("/codex-pool add");
  });

  test("uses native full stream options for stream and simple options for streamSimple", async () => {
    const path = await storePath();
    let fullOptions: CodexFullStreamOptions | undefined;
    let simpleCalled = false;
    const simple = () => {
      simpleCalled = true;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    };
    const full = (_model: never, _context: never, options?: CodexFullStreamOptions) => {
      fullOptions = options;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    };
    const runtime = new PoolRuntime(new PoolStore(path), native(simple as never, undefined, full as never));
    await runtime.load();
    const account = await runtime.addAccount("A", credentials("A"));
    const provider = runtime.provider();
    await events(provider.stream(model(), { messages: [] }, { apiKey: POOL_SENTINEL, reasoningEffort: "high" }));
    expect(fullOptions).toMatchObject({ apiKey: account.credentials.access, reasoningEffort: "high" });
    expect(simpleCalled).toBe(false);
  });

  test("uses the native stream with a selected token instead of the availability sentinel", async () => {
    const path = await storePath();
    let seenOptions: { apiKey?: string; temperature?: number } = {};
    const streamSimple = (_model: never, _context: never, options?: { apiKey?: string; temperature?: number }) => {
      seenOptions = { ...options };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    };
    const runtime = new PoolRuntime(new PoolStore(path), native(streamSimple as never));
    await runtime.load();
    const account = await runtime.addAccount("A", credentials("A"));
    const provider = runtime.provider();
    const auth = await provider.auth.apiKey!.resolve({} as never);
    expect(auth?.auth.apiKey).toBe(POOL_SENTINEL);
    await events(provider.streamSimple(model(), { messages: [] }, { apiKey: POOL_SENTINEL, temperature: 0.25 }));
    expect(seenOptions).toMatchObject({ apiKey: account.credentials.access, temperature: 0.25 });
  });

  test("session shutdown revokes status and aborts refresh work", async () => {
    const path = await storePath();
    const statuses: string[] = [];
    const runtime = new PoolRuntime(new PoolStore(path), native(() => createAssistantMessageEventStream()), async () => ({ fiveHour: 50, weekly: 50, capturedAt: Date.now() }));
    await runtime.load();
    await runtime.addAccount("A", credentials("A"));
    runtime.startSession({ ui: { setStatus: (_key: string, value: string | undefined) => { if (value) statuses.push(value ?? ""); } } } as never);
    await new Promise((resolve) => setTimeout(resolve, 30));
    runtime.stopSession();
    expect(statuses[0]).toContain("codex A");
  });
});
