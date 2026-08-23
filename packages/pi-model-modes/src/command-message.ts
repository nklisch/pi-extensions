import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Send a display-only command panel without allowing a runtime Promise return
 * from pi.sendMessage to become an unhandled rejection. The published type is
 * void, but newer hosts may return a Promise while session replacement or a
 * stale command context is being detected.
 */
export async function sendCommandMessageSafely(
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: Pick<ExtensionCommandContext, "ui">,
  message: Parameters<ExtensionAPI["sendMessage"]>[0],
  surface: string,
): Promise<void> {
  try {
    await Promise.resolve(pi.sendMessage(message));
  } catch (error) {
    // The command context can be stale too, so notification is best effort.
    // The send failure has already been consumed; neither path may escape as
    // an unhandled rejection or replace the command's primary outcome.
    try {
      ctx.ui.notify(
        `${surface}: status panel unavailable (${error instanceof Error ? error.message : String(error)})`,
        "error",
      );
    } catch {
      // A stale UI context has no safe recovery channel at this boundary.
    }
  }
}
