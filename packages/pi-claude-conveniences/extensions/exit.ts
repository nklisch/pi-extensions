/**
 * pi-claude-conveniences — small drop-in conveniences for muscle-memory parity
 * with Claude Code, Codex, and common shells.
 *
 * Currently registers:
 *   - /exit : gracefully shut pi down (alias for the built-in /quit).
 *
 * The extension has no dependencies (it only calls ctx.shutdown()) and uses a
 * locally-typed PiApi slice so it stays unit-testable with a fake pi under
 * bare `bun test`.
 */

type CommandContext = {
  /** Gracefully shut pi down and exit. Provided by pi on the command context. */
  shutdown?: () => void;
};

type PiApi = {
  registerCommand?: (
    name: string,
    options: {
      description?: string;
      handler: (args: string | undefined, ctx: CommandContext) => Promise<void>;
    },
  ) => void;
};

export default function exitCommandExtension(pi: PiApi): void {
  pi.registerCommand?.("exit", {
    description: "Exit pi (graceful shutdown)",
    handler: async (_args, ctx) => {
      // ctx.shutdown() is documented as "Gracefully shutdown pi and exit" and
      // is available in all extension contexts. It runs session_shutdown
      // handlers (e.g. background-tasks cancels its jobs) before exiting.
      ctx.shutdown?.();
    },
  });
}
