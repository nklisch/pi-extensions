import { describe, expect, it, vi } from "vitest";
import { createPiTrustReview } from "../../src/pi/pi-trust-review.js";
import { trustedInstallFlowFixture } from "../fixtures/trusted-install/plugin-install-flow.js";

/**
 * The review drives the real facade contract: canned envelopes keyed by the
 * command path, a confirm stub, and a notify log. No pi runtime required.
 */

const base = trustedInstallFlowFixture.chooseInspect;
const installedSummary = { ...base.summary, subject: "installed", condition: "blocked" };
const page = {
  snapshotId: base.snapshotId,
  condition: "blocked",
  items: [installedSummary],
  observations: [],
};

function detailWith(trust: string) {
  return { kind: "found", detail: { ...base, summary: installedSummary, trust } };
}

function envelope(status: string, data: unknown) {
  return {
    envelope: {
      schemaVersion: 1,
      command: { id: "inspection.list", path: [], grammarVersion: "plugin-control/v1", invocation: "list" },
      status,
      exit: { code: 0 },
      diagnostics: [],
      human: [],
      data,
      redactions: [],
    },
    delivery: "local",
    deliveredThrough: "facade",
  };
}

function fixture(options: { trust?: string; confirm?: boolean; grantStatus?: string; mode?: string; trustsByPlugin?: Record<string, string> } = {}) {
  const calls: string[][] = [];
  const notifications: Array<{ message: string; kind: string }> = [];
  const trustFor = (plugin: unknown) => options.trustsByPlugin?.[plugin as string] ?? options.trust ?? "required";
  const items = options.trustsByPlugin === undefined
    ? [installedSummary]
    : Object.keys(options.trustsByPlugin).map((plugin, index) => ({
        ...installedSummary,
        plugin,
        detailId: `${installedSummary.detailId.slice(0, -1)}${index}`,
      }));
  const pageFor = { ...page, items };
  const application = {
    control: {
      async runArgv(argv: readonly string[]) {
        calls.push([...argv]);
        if (argv[0] === "list") return envelope("ok", pageFor);
        if (argv[0] === "show") return envelope("ok", detailWith(trustFor(argv[1])));
        if (argv[0] === "trust") return envelope(options.grantStatus ?? "ok", { kind: "granted", plugin: argv[1], scope: installedSummary.scope, subject: "trust-subject-v1:sha256:" + "1".repeat(64) });
        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      },
    },
  };
  const host = {
    current: () => ({}),
    async runWithPiOperationContext(_context: unknown, _signal: AbortSignal, use: (application: unknown) => Promise<unknown>) {
      return use(application);
    },
  };
  const context = {
    mode: options.mode ?? "tui",
    hasUI: true,
    ui: {
      confirm: vi.fn(async () => options.confirm ?? true),
      notify: (message: string, kind: string) => { notifications.push({ message, kind }); },
    },
  };
  const review = createPiTrustReview({ host: host as never });
  return { review, context: context as never, calls, notifications, confirm: context.ui.confirm };
}

describe("pi session trust review", () => {
  it("prompts for trust-required blocked plugins and grants on accept", async () => {
    const { review, context, calls, notifications, confirm } = fixture({ confirm: true });
    await review.review(context);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toBe(`Trust ${installedSummary.name.text} again?`);
    expect(calls.map((argv) => argv[0])).toEqual(["list", "show", "trust"]);
    const grant = calls.find((argv) => argv[0] === "trust")!;
    expect(grant).toContain("--yes");
    expect(grant).toContain(installedSummary.plugin);
    expect(notifications.some((entry) => entry.kind === "info" && entry.message.includes("run /reload"))).toBe(true);
  });

  it("does not grant when the user declines", async () => {
    const { review, context, calls } = fixture({ confirm: false });
    await review.review(context);
    expect(calls.map((argv) => argv[0])).toEqual(["list", "show"]);
  });

  it("skips plugins whose trust verdict a grant cannot resolve", async () => {
    for (const trust of ["revoked", "invalid-evidence", "authorized", "project-untrusted"]) {
      const { review, context, calls, confirm } = fixture({ trust });
      await review.review(context);
      expect(confirm).not.toHaveBeenCalled();
      expect(calls.map((argv) => argv[0])).toEqual(["list", "show"]);
    }
  });

  it("stays silent outside the TUI", async () => {
    const { review, context, calls, confirm } = fixture({ mode: "json" });
    await review.review(context);
    expect(calls).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("warns instead of granting silently when the grant fails", async () => {
    const { review, context, notifications } = fixture({ grantStatus: "rejected" });
    await review.review(context);
    expect(notifications.some((entry) => entry.kind === "warning" && entry.message.includes("Could not trust"))).toBe(true);
    expect(notifications.some((entry) => entry.kind === "info")).toBe(false);
  });

  it("does not let non-trust blocks starve the prompt budget", async () => {
    const { review, context, calls, confirm } = fixture({
      trustsByPlugin: { "a@market": "authorized", "b@market": "revoked", "c@market": "invalid-evidence", "d@market": "required" },
    });
    await review.review(context);
    expect(confirm).toHaveBeenCalledOnce();
    expect(calls.filter((argv) => argv[0] === "trust").map((argv) => argv[1])).toEqual(["d@market"]);
  });

  it("advises reload when a concurrent grant already recorded trust", async () => {
    const { review, context, notifications } = fixture({ grantStatus: "no-change" });
    await review.review(context);
    expect(notifications.some((entry) => entry.kind === "info" && entry.message.includes("run /reload"))).toBe(true);
    expect(notifications.some((entry) => entry.kind === "warning")).toBe(false);
  });

  it("caps prompts when many plugins are trust-required", async () => {
    const { review, context, confirm } = fixture({
      trustsByPlugin: { "a@market": "required", "b@market": "required", "c@market": "required", "d@market": "required" },
    });
    await review.review(context);
    expect(confirm).toHaveBeenCalledTimes(3);
  });
});
