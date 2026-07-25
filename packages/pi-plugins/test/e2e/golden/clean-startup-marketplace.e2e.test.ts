import { afterEach, describe, expect, it } from "vitest";
import { E2E_CHECKOUT_ROOT } from "../harness/constants.js";
import { cleanupSandbox, createCleanE2ESandbox, type CleanE2ESandbox } from "../harness/environment.js";
import { candidate, seedRemoteMarketplace, startPackedRpc } from "../harness/journey.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

const plugins = [
  "core-local@native-e2e-market",
  "project-local@native-e2e-market",
  "secret-required@native-e2e-market",
  "mcp-required@native-e2e-market",
  "subagent-required@native-e2e-market",
  "production-bundle@native-e2e-market",
  "incompatible@native-e2e-market",
];

describe("packed golden startup, marketplace, browse, and inspection", () => {
  it("starts empty and reports only honest local runtime capabilities", async () => {
    sandbox = await createCleanE2ESandbox("golden-clean-startup");
    const rpc = await startPackedRpc(sandbox);
    const [status, installed, marketplaces] = await Promise.all([
      rpc.plugin("--non-interactive status", "status"),
      rpc.plugin("--non-interactive list --scope all-current --limit 50", "inspection.list"),
      rpc.plugin("--non-interactive marketplace list --limit 50", "marketplace.list"),
    ]);
    expect(status.envelope.data).toMatchObject({
      status: "ready",
      capabilities: {
        secrets: { status: "unavailable" },
        mcp: { status: "available", explanation: expect.stringContaining("RUNTIME_ALIAS_UNAVAILABLE") },
        subagents: { status: "available" },
        piReload: { status: "available" },
      },
    });
    expect(installed.envelope.data.items).toEqual([]);
    expect(marketplaces.envelope.data.registrations).toEqual([]);
    await rpc.shutdown();
  });

  it("adds one HTTPS Git marketplace and keeps exact candidate identities stable", async () => {
    sandbox = await createCleanE2ESandbox("golden-marketplace-browse");
    const journey = await seedRemoteMarketplace(sandbox);
    expect(journey.browse.envelope.data.candidates.map((entry: any) => entry.plugin).sort()).toEqual(plugins.toSorted());
    const core = candidate(journey.browse, plugins[0]!);
    const secondRead = await journey.rpc.plugin("--non-interactive browse --scope user --limit 50", "browse");
    expect(candidate(secondRead, plugins[0]!).id).toBe(core.id);
    expect(candidate(secondRead, plugins[0]!).snapshot).toBe(core.snapshot);
    const gitRequests = await journey.git.requests();
    expect(gitRequests).toContainEqual(expect.objectContaining({
      method: "GET",
      query: expect.stringContaining("service=git-upload-pack"),
      protocol: "version=2",
    }));
    expect(JSON.stringify(secondRead)).not.toContain(E2E_CHECKOUT_ROOT);
    await journey.rpc.shutdown();
  });

  it("exposes exact candidate detail and unavailable siblings", async () => {
    sandbox = await createCleanE2ESandbox("golden-candidate-inspection");
    const journey = await seedRemoteMarketplace(sandbox);
    const detail = await journey.rpc.plugin(`--non-interactive show ${plugins[0]} --scope user`, "inspection.show");
    expect(detail.envelope).toMatchObject({
      status: "ok",
      data: {
        kind: "found",
        detail: {
          summary: { plugin: plugins[0] },
          compatibility: {
            status: "activatable",
            components: { counts: { skills: 1, hooks: 1, mcpServers: 0, foreign: 0 } },
          },
          trust: "required",
        },
      },
    });
    const unavailable = new Map([
      ["secret-required@native-e2e-market", { compatibility: "activatable", diagnostic: "SECRET_CUSTODY_UNAVAILABLE" }],
      ["mcp-required@native-e2e-market", { compatibility: "activatable", capability: "pi.mcp.runtime" }],
      ["subagent-required@native-e2e-market", { compatibility: "activatable", capability: "pi.subagents.lifecycle-interception" }],
      ["incompatible@native-e2e-market", { compatibility: "incompatible", diagnostic: "COMPATIBILITY_INCOMPATIBLE" }],
    ]);
    for (const [plugin, expected] of unavailable) {
      const report = await journey.rpc.plugin(`--non-interactive show ${plugin} --scope user`, "inspection.show");
      expect(report.envelope, plugin).toMatchObject({ status: "ok", data: { kind: "found", detail: { compatibility: { status: expected.compatibility } } } });
      if ("diagnostic" in expected) {
        expect(report.envelope.data.detail.diagnostics.map((item: any) => item.code), plugin).toContain(expected.diagnostic);
      } else {
        expect(report.envelope.data.detail.compatibility.requirements, plugin).toContainEqual(expect.objectContaining({ capability: expect.objectContaining({ text: expected.capability }), status: "available" }));
      }
    }
    await journey.rpc.shutdown();
  });
});
