import { HostStartupResultSchema, type HostStartupResult } from "../application/host-observation-contract.js";

export interface PackagedHostStartup {
  start(signal: AbortSignal): Promise<HostStartupResult>;
  close(): Promise<void>;
}

/** Explicit local-only startup order shared by packaged composition tests/adapters. */
export function createPackagedHostStartup(dependencies: Readonly<{
  open(signal: AbortSignal): Promise<void>;
  recover(signal: AbortSignal): Promise<Readonly<{ blocked: HostStartupResult["blocked"] }>>;
  reconcile(signal: AbortSignal): Promise<Readonly<{ blocked: HostStartupResult["blocked"] }>>;
  capabilities(signal: AbortSignal): Promise<HostStartupResult["capabilities"]>;
  publish(status: HostStartupResult): void;
  startBackground(): Promise<void>;
  closeResources(): Promise<void>;
}>): PackagedHostStartup {
  let started: Promise<HostStartupResult> | undefined;
  let closed: Promise<void> | undefined;

  return Object.freeze({
    start(signal: AbortSignal) {
      started ??= (async () => {
        signal.throwIfAborted();
        await dependencies.open(signal);
        const capabilities = await dependencies.capabilities(signal);
        const recovery = await dependencies.recover(signal);
        // Recovery settlement is authoritative before any local projection is
        // rebuilt or observed.
        const runtime = await dependencies.reconcile(signal);
        const blocked = [...recovery.blocked, ...runtime.blocked];
        const result = HostStartupResultSchema.parse({
          status: blocked.length === 0 ? "ready" : "degraded",
          blocked,
          capabilities,
        });
        dependencies.publish(result);
        // Remote work begins only after immutable local status publication and
        // is deliberately detached from session readiness.
        void dependencies.startBackground().catch(() => undefined);
        return result;
      })();
      return started;
    },
    close() {
      closed ??= (async () => {
        await started?.catch(() => undefined);
        await dependencies.closeResources();
      })();
      return closed;
    },
  });
}
