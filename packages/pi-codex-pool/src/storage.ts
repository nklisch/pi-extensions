import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { PoolState } from "./types.ts";
import { DEFAULT_THRESHOLD, MAX_LABEL_LENGTH } from "./types.ts";

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

export const defaultPoolState = (): PoolState => ({
  accounts: [],
  thresholds: { fiveHour: DEFAULT_THRESHOLD, weekly: DEFAULT_THRESHOLD },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validCredential(value: unknown): boolean {
  return isRecord(value)
    && value.type === "oauth"
    && typeof value.refresh === "string"
    && value.refresh.length > 0
    && typeof value.access === "string"
    && value.access.length > 0
    && typeof value.expires === "number"
    && Number.isFinite(value.expires);
}

function validQuotaPercentage(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);
}

function validQuota(value: unknown): boolean {
  return isRecord(value)
    && validQuotaPercentage(value.fiveHour)
    && validQuotaPercentage(value.weekly)
    && typeof value.capturedAt === "number"
    && Number.isFinite(value.capturedAt);
}

export function validatePoolState(value: unknown): PoolState {
  if (!isRecord(value) || !Array.isArray(value.accounts) || !isRecord(value.thresholds)) {
    throw new Error("invalid Codex pool state");
  }
  const fiveHour = value.thresholds.fiveHour as number;
  const weekly = value.thresholds.weekly as number;
  if (![fiveHour, weekly].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 100)) {
    throw new Error("invalid Codex pool thresholds");
  }

  const accounts = value.accounts.map((raw) => {
    if (!isRecord(raw)
      || typeof raw.id !== "string" || !raw.id
      || typeof raw.label !== "string" || !raw.label
      || [...raw.label].length > MAX_LABEL_LENGTH
      || /[\u0000-\u001f\u007f\u001b]/u.test(raw.label)
      || raw.label.includes("·")
      || typeof raw.providerAccountId !== "string" || !raw.providerAccountId
      || !validCredential(raw.credentials)
      || (raw.quota !== undefined && !validQuota(raw.quota))
      || (raw.quotaFailed !== undefined && typeof raw.quotaFailed !== "boolean")
      || (raw.lastError !== undefined && typeof raw.lastError !== "string")) {
      throw new Error("invalid Codex pool account");
    }
    return {
      id: raw.id,
      label: raw.label,
      providerAccountId: raw.providerAccountId,
      credentials: raw.credentials as PoolState["accounts"][number]["credentials"],
      ...(raw.quota === undefined ? {} : { quota: raw.quota as PoolState["accounts"][number]["quota"] }),
      ...(raw.quotaFailed === true ? { quotaFailed: true } : {}),
      ...(raw.lastError === undefined ? {} : { lastError: raw.lastError }),
    };
  });

  const ids = new Set<string>();
  const providerIds = new Set<string>();
  const labels = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id) || providerIds.has(account.providerAccountId)) throw new Error("duplicate Codex pool account");
    if (labels.has(account.label)) throw new Error("duplicate Codex pool label");
    ids.add(account.id);
    providerIds.add(account.providerAccountId);
    labels.add(account.label);
  }
  if (value.activeAccountId !== undefined && (typeof value.activeAccountId !== "string" || !ids.has(value.activeAccountId))) {
    throw new Error("invalid Codex pool active account");
  }
  return {
    accounts,
    thresholds: { fiveHour, weekly },
    ...(value.activeAccountId === undefined ? {} : { activeAccountId: value.activeAccountId }),
  };
}

function errorText(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
  } catch {
    return "unknown storage error";
  }
}

function parseState(raw: string): PoolState {
  try {
    return validatePoolState(JSON.parse(raw) as unknown);
  } catch (error) {
    // Node 24 includes nearby source text in JSON.parse errors. Never pass that
    // text into a log or mutation error because the file contains OAuth tokens.
    if (error instanceof SyntaxError) throw new Error("invalid Codex pool JSON");
    throw error;
  }
}

async function ownerToken(path: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return undefined;
  }
  const owner = entries.find((entry) => entry.startsWith("owner-") && entry.length > "owner-".length);
  if (!owner) return undefined;
  const token = owner.slice("owner-".length);
  try {
    if ((await readFile(`${path}/${owner}`, "utf8")).trim() !== token) return undefined;
  } catch {
    return undefined;
  }
  return token;
}

async function staleLock(path: string): Promise<boolean> {
  const token = await ownerToken(path);
  let heartbeat;
  try {
    heartbeat = await stat(token ? `${path}/heartbeat-${token}` : path);
  } catch {
    try { heartbeat = await stat(`${path}/owner-${token ?? "missing"}`); } catch { return false; }
  }
  return Date.now() - heartbeat.mtimeMs > LOCK_STALE_MS;
}

async function recoverStaleLock(path: string): Promise<void> {
  if (!await staleLock(path)) return;
  const takeover = `${path}.takeover-${randomUUID()}`;
  try {
    // Rename is atomic within the parent directory. Quarantine-before-delete
    // prevents a contender from deleting a newly acquired lock and losing a
    // serialized state update when an old process has crashed.
    await rename(path, takeover);
    await rm(takeover, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await rm(takeover, { recursive: true, force: true }).catch(() => {});
    }
  }
}

class DirectoryLock {
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly token = randomUUID();
  private readonly ownerPath: string;
  private readonly heartbeatPath: string;

  private constructor(private readonly path: string) {
    this.ownerPath = `${path}/owner-${this.token}`;
    this.heartbeatPath = `${path}/heartbeat-${this.token}`;
  }

  private async owns(): Promise<boolean> {
    try {
      return (await readFile(this.ownerPath, "utf8")).trim() === this.token;
    } catch {
      return false;
    }
  }

  private async refreshAndAssert(): Promise<void> {
    if (!await this.owns()) throw new Error("Codex pool state lock ownership was lost");
    // Heartbeats are created once during acquisition. A former owner must not
    // recreate a removed heartbeat in a successor's lock or after release.
    await utimes(this.heartbeatPath, new Date(), new Date());
    if (!await this.owns()) throw new Error("Codex pool state lock ownership was lost");
  }

  static async acquire(path: string): Promise<DirectoryLock> {
    const started = Date.now();
    while (Date.now() - started < LOCK_TIMEOUT_MS) {
      try {
        await mkdir(path);
        const lock = new DirectoryLock(path);
        await writeFile(lock.ownerPath, `${lock.token}\n`, { mode: 0o600 });
        await writeFile(lock.heartbeatPath, `${lock.token}\n`, { mode: 0o600 });
        await lock.refreshAndAssert();
        lock.heartbeat = setInterval(() => {
          void lock.refreshAndAssert().catch(() => {});
        }, LOCK_HEARTBEAT_MS);
        lock.heartbeat.unref?.();
        return lock;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await recoverStaleLock(path);
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    throw new Error("Codex pool state lock is busy");
  }

  async assertBeforeWrite(): Promise<void> {
    await this.refreshAndAssert();
  }

  async release(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      // A former owner must not refresh or remove anything in a successor's
      // directory. Token-specific paths plus non-recursive rmdir make cleanup
      // identity-safe even when takeover happened while this process paused.
      await this.refreshAndAssert();
    } catch {
      return;
    }
    await rm(this.heartbeatPath, { force: true });
    await rm(this.ownerPath, { force: true });
    try {
      await rmdir(this.path);
    } catch (error) {
      if (!(["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))) throw error;
    }
  }
}

export class PoolStore {
  constructor(readonly path: string) {}

  async load(): Promise<PoolState> {
    try {
      return parseState(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try { console.error(`[codex-pool] ignoring unavailable state: ${errorText(error)}`); } catch { /* teardown */ }
      }
      return defaultPoolState();
    }
  }

  async mutate(mutator: (state: PoolState) => PoolState | Promise<PoolState>): Promise<PoolState> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700).catch(() => {});
    const lock = await DirectoryLock.acquire(`${this.path}.lock`);
    try {
      let current: PoolState;
      try {
        current = parseState(await readFile(this.path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") current = defaultPoolState();
        else {
          // A malformed file is not allowed to be silently replaced by a command.
          // Startup still degrades to an empty pool; only this mutation fails.
          throw new Error(`Cannot mutate Codex pool state: ${errorText(error)}`);
        }
      }
      const next = validatePoolState(await mutator(current));
      await this.writeAtomic(next, lock);
      return next;
    } finally {
      try {
        await lock.release();
      } catch {
        // The state write already completed. A later mutation can acquire a new lock.
      }
    }
  }

  private async writeAtomic(state: PoolState, lock: DirectoryLock): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => {});
    const temporary = `${this.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600).catch(() => {});
      // The rename is the protected state write; recheck after temp I/O so a
      // paused former owner cannot publish its snapshot after takeover.
      await lock.assertBeforeWrite();
      await rename(temporary, this.path);
      await chmod(this.path, 0o600).catch(() => {});
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
