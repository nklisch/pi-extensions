import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NativeInspectionDetailResultSchema, NativeInspectionPageSchema } from "../application/native-inspection-contract.js";
import type { NativeControlExecutionReport } from "../application/ports/native-control-execution.js";
import type { PackagedPluginHost } from "../composition/packaged-plugin-host-contract.js";
import { nativeControlArgv } from "./manager/plugin-manager-commands.js";

/**
 * Session-start re-trust surface. When an installed plugin's executable
 * content changes outside a managed update (rebuilt local source, rewritten
 * payload), the runtime's exact-trust check fails closed and the plugin's
 * hooks/MCP servers die with raw authority errors. Instead of leaving that
 * failure to surface inside hook/MCP channels, offer the one decision that
 * resolves it: trust this exact content again, then reload so activation
 * picks the grant up.
 */

/** Never prompt more than this many times in one session start. */
const MAX_PROMPTS = 3;
/** Detail lookups are bounded independently so non-trust blocks can't starve the budget. */
const MAX_DETAIL_LOOKUPS = 10;

async function run(
  host: PackagedPluginHost,
  context: ExtensionContext,
  argv: readonly string[],
  signal: AbortSignal,
): Promise<NativeControlExecutionReport | undefined> {
  try {
    return await host.runWithPiOperationContext(context, signal, (application) =>
      application.control.runArgv(argv, {
        mode: context.mode,
        output: "json",
      }, signal));
  } catch {
    return undefined;
  }
}

export type PiTrustReview = Readonly<{
  review(context: ExtensionContext): Promise<void>;
}>;

export function createPiTrustReview(input: Readonly<{ host: PackagedPluginHost }>): PiTrustReview {
  return Object.freeze({
    async review(context) {
      // Prompt custody only exists interactively; headless consumers read the
      // same trust verdicts through /plugins list|show and grant with --yes.
      if (context.mode !== "tui" || !context.hasUI) return;
      const host = input.host.current();
      if (host === undefined) return;
      const controller = new AbortController();
      const signal = controller.signal;

      const page = await run(input.host, context, nativeControlArgv("inspection.list", [], { scope: "all-current", limit: 50 }), signal);
      const items = page === undefined ? undefined : NativeInspectionPageSchema.safeParse(page.envelope.data);
      if (items === undefined || !items.success) return;
      const blocked = items.data.items.filter((item) => item.condition === "blocked").slice(0, MAX_DETAIL_LOOKUPS);

      const granted: string[] = [];
      let prompted = 0;
      for (const item of blocked) {
        if (prompted >= MAX_PROMPTS) break;
        const scope = item.scope.kind;
        const detailReport = await run(input.host, context, nativeControlArgv("inspection.show", [item.plugin], {
          scope,
          snapshotId: items.data.snapshotId,
          detailId: item.detailId,
        }), signal);
        const detail = detailReport === undefined ? undefined : NativeInspectionDetailResultSchema.safeParse(detailReport.envelope.data);
        if (detail === undefined || !detail.success || detail.data.kind !== "found") continue;
        // "required" is the only verdict a fresh grant resolves: "revoked"
        // was a deliberate user act, "project-untrusted" cannot be fixed
        // here, and "invalid-evidence" means the evidence itself is broken.
        if (detail.data.detail.trust !== "required") continue;
        prompted += 1;

        const name = detail.data.detail.summary.name.text;
        const accepted = await context.ui.confirm(
          `Trust ${name} again?`,
          `${item.plugin} (${scope} scope): its executable content changed since you trusted it, ` +
          "so its skills, hooks, and MCP servers are not running. Trust this exact content and continue?",
        ).catch(() => undefined);
        if (accepted !== true) continue;

        const grant = await run(input.host, context, nativeControlArgv("trust.grant", [item.plugin], {
          scope,
          snapshotId: items.data.snapshotId,
          detailId: item.detailId,
          confirmed: true,
        }), signal);
        // "no-change" means trust is already held (e.g. a concurrent grant);
        // either way the runtime still needs a reload to pick it up.
        if (grant?.envelope.status === "ok" || grant?.envelope.status === "no-change") granted.push(item.plugin);
        else if (grant !== undefined) {
          const why = grant.envelope.human[0]?.text ?? grant.envelope.diagnostics[0]?.code;
          context.ui.notify(`Could not trust ${item.plugin}${why === undefined ? "" : ` — ${why}`}. /plugins doctor has details.`, "warning");
        }
      }

      if (granted.length === 0) return;
      // Session contexts carry no reload authority (command contexts do), so
      // activation completes on the user's explicit reload. The grant is
      // durable: without one, the next session starts clean anyway.
      context.ui.notify(`Trusted ${granted.join(", ")} — run /reload to activate.`, "info");
    },
  });
}
