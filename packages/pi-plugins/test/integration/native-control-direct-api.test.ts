import { describe, expect, it } from "vitest";
import { createNativeControlParser } from "../../src/application/native-control-parser.js";
import { nativeControlCommandIds } from "../../src/application/native-control-registry.js";

const hex = (value: string) => value.repeat(64);
const registration = `marketplace-registration-v1:sha256:${hex("a")}`;
const adoption = `adoption-v1:sha256:${hex("b")}`;
const installToken = `trusted-install-session-v1:123e4567-e89b-42d3-a456-426614174000.${hex("c")}`;
const operationToken = `native-operation-session-v1:123e4567-e89b-42d3-a456-426614174000.${hex("d")}`;
const preview = `update-policy-preview-v1:sha256:${hex("e")}`;
const notice = `update-notice-v1:sha256:${hex("f")}`;

const samples: Readonly<Record<string, readonly string[]>> = {
  presentation: [],
  help: ["help"],
  grammar: ["grammar"],
  "marketplace.add": ["marketplace", "add", "owner/repo"],
  "marketplace.remove": ["marketplace", "remove", registration, "--yes"],
  "marketplace.list": ["marketplace", "list"],
  "marketplace.refresh": ["marketplace", "refresh", registration],
  "marketplace.adopt.preview": ["marketplace", "adopt", "preview"],
  "marketplace.adopt.import": ["marketplace", "adopt", "import", adoption, "--yes"],
  browse: ["browse", "demo"],
  "inspection.list": ["list"],
  "inspection.show": ["show", "demo@market", "--scope", "user"],
  "inspection.diagnose": ["diagnose"],
  "install.open": ["install", "open", "demo@market", "--scope", "user"],
  "install.apply": ["install", "apply", installToken],
  "install.recover": ["install", "recover", installToken],
  "install.run": ["install", "demo@market", "--scope", "user"],
  "lifecycle.enable": ["enable", "demo@market", "--scope", "user", "--yes"],
  "lifecycle.disable": ["disable", "demo@market", "--scope", "user", "--yes"],
  "lifecycle.update": ["update", "demo@market", "--scope", "user"],
  "lifecycle.uninstall": ["uninstall", "demo@market", "--scope", "user", "--yes", "--keep-data"],
  "project.sync": ["project", "sync", "--mode", "apply-intent", "--preview-only"],
  "updates.status": ["updates", "status"],
  "updates.policy.preview": ["updates", "policy", "preview", "--kind", "application", "--target", "global", "--mode", "manual"],
  "updates.policy.apply": ["updates", "policy", "apply", "--kind", "application", "--target", "global", "--mode", "manual", "--preview-id", preview],
  "updates.policy.set": ["updates", "policy", "set", "--kind", "cadence", "--target", "global", "--cadence", "balanced"],
  "updates.notices.list": ["updates", "notices", "list"],
  "updates.notices.acknowledge": ["updates", "notices", "acknowledge", notice],
  "updates.automatic.run": ["updates", "automatic", "run"],
  "config.host-precedence": ["config", "host-precedence", "codex-first"],
  status: ["status"],
  "operation.status": ["operation", "status", operationToken],
  "operation.cancel": ["operation", "cancel", operationToken],
};

describe("native control direct grammar acceptance", () => {
  it("parses every canonical command from the registry", () => {
    const parser = createNativeControlParser();
    expect(Object.keys(samples).sort()).toEqual([...nativeControlCommandIds()].sort());
    for (const [id, argv] of Object.entries(samples)) {
      const result = parser.parseArgv(argv);
      if (id === "help") expect(result).toMatchObject({ kind: "help" });
      else expect(result, `${id}: ${JSON.stringify(result)}`).toMatchObject({ kind: "parsed", command: { command: id } });
    }
  });

  it.each([
    [["marketplace", "update"], "marketplace.refresh"],
    [["adopt", "preview"], "marketplace.adopt.preview"],
    [["adopt", "import", adoption, "--yes"], "marketplace.adopt.import"],
    [["inspect", "demo@market", "--scope", "user"], "inspection.show"],
    [["install", "run", "demo@market", "--scope", "user"], "install.run"],
    [["project-sync", "--mode", "merge", "--preview-only"], "project.sync"],
    [["updates", "notices", "ack", notice], "updates.notices.acknowledge"],
  ] as const)("canonicalizes alias %j", (argv, id) => {
    expect(createNativeControlParser().parseArgv(argv)).toMatchObject({ kind: "parsed", command: { command: id } });
  });
});
