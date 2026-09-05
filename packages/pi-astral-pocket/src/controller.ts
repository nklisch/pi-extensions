import type { DistillerResult } from "./distiller.js";

export type PassOutcome =
  | { state: "idle" }
  | { state: "running"; startedAt: string }
  | { state: "completed"; finishedAt: string; result: DistillerResult }
  | { state: "failed"; finishedAt: string; error: string }
  | { state: "cancelled"; finishedAt: string };

export type PassReporter = (message: string, level: "info" | "warning" | "error") => void;

/** Own one serialized, revocable background pass for this extension instance. */
export class DistillerController {
  private generation = 0;
  private controller: AbortController | undefined;
  private queue: Promise<void> = Promise.resolve();
  private reporter: PassReporter | undefined;
  private outcome: PassOutcome = { state: "idle" };

  status(): PassOutcome {
    return this.outcome;
  }

  stop(): void {
    this.generation += 1;
    this.reporter = undefined;
    this.controller?.abort();
    this.controller = undefined;
    if (this.outcome.state === "running") {
      this.outcome = { state: "cancelled", finishedAt: new Date().toISOString() };
    }
  }

  start(
    task: (signal: AbortSignal) => Promise<DistillerResult>,
    reporter?: PassReporter,
  ): Promise<void> {
    this.stop();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.reporter = reporter;
    const run = async () => {
      if (controller.signal.aborted || generation !== this.generation) return;
      this.outcome = { state: "running", startedAt: new Date().toISOString() };
      try {
        const result = await task(controller.signal);
        if (controller.signal.aborted || generation !== this.generation) return;
        this.outcome = { state: "completed", finishedAt: new Date().toISOString(), result };
        if (result.errors.length > 0) {
          this.report(generation, `Astral Pocket distillation finished with ${result.errors.length} error(s); source notes remain available.`, "warning");
        }
      } catch (error) {
        if (controller.signal.aborted || generation !== this.generation) return;
        const message = error instanceof Error ? error.message : String(error);
        this.outcome = { state: "failed", finishedAt: new Date().toISOString(), error: message };
        this.report(generation, `Astral Pocket distillation failed: ${message}. Source notes remain available.`, "warning");
      } finally {
        if (generation === this.generation) {
          this.controller = undefined;
          this.reporter = undefined;
        }
      }
    };
    this.queue = this.queue.catch(() => undefined).then(run);
    return this.queue;
  }

  private report(generation: number, message: string, level: "info" | "warning" | "error"): void {
    if (generation !== this.generation || !this.reporter) return;
    try {
      this.reporter(message, level);
    } catch {
      // Session replacement can revoke a UI sink between the generation check
      // and notification. Reporting failure must never escape this boundary.
    }
  }
}
