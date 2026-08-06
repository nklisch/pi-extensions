// ---- Narrow interfaces ----

/** Narrow settings interface required by the subagents:settings command. */
export interface SubagentsSettingsManager {
  readonly maxConcurrent: number;
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number;
  readonly consumedSessionRetentionMinutes: number;
  readonly unconsumedSessionRetentionMinutes: number;
  readonly abortAllOnInterrupt: boolean;
  readonly fallbackSubagent: string | false | undefined;
  applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" };
  applyDefaultMaxTurns(n: number): { message: string; level: "info" | "warning" };
  applyGraceTurns(n: number): { message: string; level: "info" | "warning" };
  applyConsumedSessionRetention(n: number): { message: string; level: "info" | "warning" };
  applyUnconsumedSessionRetention(n: number): { message: string; level: "info" | "warning" };
  applyAbortAllOnInterrupt(value: boolean): { message: string; level: "info" | "warning" };
  applyFallbackSubagent(value: string | false | undefined): { message: string; level: "info" | "warning" };
}

/** Narrow UI interface — only the ctx.ui methods the settings handler calls. */
export interface SubagentsSettingsUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, defaultValue?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

/** Registry operations needed to offer only valid fallback agents. */
export interface SubagentsSettingsAgentRegistry {
  reload(): void;
  getAvailableTypes(): string[];
}

// ---- Class ----

/**
 * Handler for the `/subagents:settings` slash command.
 *
 * Call `handle({ ui })` from the Pi command registration to open the interactive
 * settings list. Lifted from `AgentsMenuHandler.showSettings`.
 */
export class SubagentsSettingsHandler {
  constructor(
    private readonly settings: SubagentsSettingsManager,
    private readonly agentRegistry: SubagentsSettingsAgentRegistry,
  ) {}

  async handle({ ui }: { ui: SubagentsSettingsUI }): Promise<void> {
    const choice = await ui.select("Settings", [
      `Max concurrency (current: ${this.settings.maxConcurrent})`,
      `Default max turns (current: ${this.settings.defaultMaxTurns ?? "unlimited"})`,
      `Grace turns (current: ${this.settings.graceTurns})`,
      `Consumed session retention (current: ${this.settings.consumedSessionRetentionMinutes}m)`,
      `Unconsumed session retention (current: ${this.settings.unconsumedSessionRetentionMinutes}m)`,
      `Abort all on ESC (current: ${this.settings.abortAllOnInterrupt ? "yes" : "no"})`,
      `Unknown agent fallback (current: ${this.settings.fallbackSubagent === false ? "none" : this.settings.fallbackSubagent ?? "general-purpose"})`,
    ]);
    if (!choice) return;

    if (choice.startsWith("Max concurrency")) {
      const val = await ui.input(
        "Max concurrent background agents",
        String(this.settings.maxConcurrent),
      );
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 1) {
          const toast = this.settings.applyMaxConcurrent(n);
          ui.notify(toast.message, toast.level);
        } else {
          ui.notify("Must be a positive integer.", "warning");
        }
      }
    } else if (choice.startsWith("Default max turns")) {
      const val = await ui.input(
        "Default max turns before wrap-up (0 = unlimited)",
        String(this.settings.defaultMaxTurns ?? 0),
      );
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 0) {
          const toast = this.settings.applyDefaultMaxTurns(n);
          ui.notify(toast.message, toast.level);
        } else {
          ui.notify("Must be 0 (unlimited) or a positive integer.", "warning");
        }
      }
    } else if (choice.startsWith("Grace turns")) {
      await this.applyNonNegativeInput(ui, "Grace turns after wrap-up steer", this.settings.graceTurns, 1, (n) => this.settings.applyGraceTurns(n));
    } else if (choice.startsWith("Consumed session retention")) {
      await this.applyNonNegativeInput(ui, "Minutes to retain a consumed live session", this.settings.consumedSessionRetentionMinutes, 0, (n) => this.settings.applyConsumedSessionRetention(n));
    } else if (choice.startsWith("Unconsumed session retention")) {
      await this.applyNonNegativeInput(ui, "Minutes to retain an unconsumed live session", this.settings.unconsumedSessionRetentionMinutes, 0, (n) => this.settings.applyUnconsumedSessionRetention(n));
    } else if (choice.startsWith("Abort all on ESC")) {
      const toast = this.settings.applyAbortAllOnInterrupt(!this.settings.abortAllOnInterrupt);
      ui.notify(toast.message, toast.level);
    } else if (choice.startsWith("Unknown agent fallback")) {
      this.agentRegistry.reload();
      const failClosed = "Fail closed (no fallback)";
      const selected = await ui.select("Fallback for unknown agent types", [
        failClosed,
        ...this.agentRegistry.getAvailableTypes(),
      ]);
      if (selected) {
        const toast = this.settings.applyFallbackSubagent(selected === failClosed ? false : selected);
        ui.notify(toast.message, toast.level);
      }
    }
  }

  private async applyNonNegativeInput(
    ui: SubagentsSettingsUI,
    title: string,
    current: number,
    minimum: number,
    apply: (value: number) => { message: string; level: "info" | "warning" },
  ): Promise<void> {
    const val = await ui.input(title, String(current));
    if (!val) return;
    const n = Number(val);
    if (!Number.isInteger(n) || n < minimum) {
      ui.notify(minimum === 0 ? "Must be a non-negative integer." : "Must be a positive integer.", "warning");
      return;
    }
    const toast = apply(n);
    ui.notify(toast.message, toast.level);
  }
}
