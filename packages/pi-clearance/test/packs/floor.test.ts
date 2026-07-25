import { describe, expect, it } from "vitest";
import { sealedFloor } from "../../src/packs/floor.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import type { BashCommandShape } from "../../src/parse/shape.ts";
import { decide } from "../../src/policy/core.ts";
import { loadEffectivePolicy } from "../../src/policy/loader.ts";
import { loadAllCorpus } from "../fixtures/load.ts";

async function bash(command: string): Promise<BashCommandShape> {
  const shape = await analyzeBashCommand(command);
  expect(shape.kind).toBe("bash");
  if (shape.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  return shape;
}

async function floorDecision(command: string) {
  return decide(await bash(command), {
    floor: sealedFloor.rules,
    active: [],
  });
}

function expectFloorDeny(
  decision: ReturnType<typeof decide>,
  ruleId: string,
): void {
  expect(decision).toMatchObject({
    effect: "deny",
    reason: expect.stringMatching(new RegExp(`^${escapeRegExp(ruleId)}:`)),
    provenance: {
      source: "shipped",
      packId: "floor.deny",
      ruleId,
    },
  });
}

function commandStages(shape: BashCommandShape) {
  return shape.stages.filter((stage) => stage.kind === "command");
}

function hardBlockCommand(command: string): string {
  const row = loadAllCorpus()
    .find((entry) => entry.file === "pi-config-classifier.json")
    ?.rows.find(
      (candidate) =>
        candidate.expected === "hard_block" && candidate.command === command,
    );
  if (row === undefined) {
    throw new Error(`expected hard_block corpus row for ${command}`);
  }
  return row.command;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("sealed floor pack", () => {
  it("exports the shipped deny floor rules", () => {
    expect(sealedFloor).toMatchObject({ version: 1, id: "floor.deny" });
    expect(sealedFloor.rules.map((rule) => rule.id)).toEqual([
      "floor:deny-rm-system-root",
      "floor:deny-privilege-escalation",
      "floor:deny-system-shutdown",
      "floor:deny-dd-device-write",
      "floor:deny-mkfs-device",
    ]);
    for (const rule of sealedFloor.rules) {
      expect(rule.effect).toBe("deny");
      expect(rule.provenance).toMatchObject({
        source: "shipped",
        packId: "floor.deny",
        ruleId: rule.id,
      });
    }
  });

  it("loads as a deny-only sealed floor", () => {
    expect(loadEffectivePolicy({ floor: sealedFloor, active: [] })).toEqual({
      ok: true,
      policy: { floor: sealedFloor.rules, active: [] },
      warnings: [],
    });
  });
});

describe("sealed floor positive matches", () => {
  it.each([
    "rm -rf /",
    "rm -rf -- /",
    "rm -rf /*",
    "rm -rf /etc",
    "rm -rf /usr",
    "rm -rf /home",
  ])("denies root/system deletion: %s", async (command) => {
    expectFloorDeny(await floorDecision(command), "floor:deny-rm-system-root");
  });

  it.each([
    "sudo apt install x",
    "su -",
    "pkexec true",
    "doas ls",
    "setcap cap_net_raw+ep ./bin",
    "runuser -u root -- ls",
    "sudo ls | head",
    "git log && sudo ls",
    "for f in a b; do sudo ls; done",
  ])("denies privilege escalation: %s", async (command) => {
    expectFloorDeny(
      await floorDecision(command),
      "floor:deny-privilege-escalation",
    );
  });

  it.each([
    "shutdown -h now",
    "reboot",
    "halt",
    "poweroff",
    "init 0",
    "init 6",
    "telinit 0",
    "systemctl poweroff",
    "systemctl reboot",
    "if true; then shutdown now; fi",
  ])("denies shutdown/reboot command: %s", async (command) => {
    expectFloorDeny(await floorDecision(command), "floor:deny-system-shutdown");
  });
});

describe("sealed floor negative lookalikes", () => {
  it.each([
    "rm -rf build",
    "rm -rf ./node_modules",
    "rm ./file",
    "systemctl status svc",
    "systemctl list-units",
    "git status",
    "ls -la",
    'grep -n "shutdown" file.rs',
    "git add shutdown.rs",
    'git commit -m "document sudo flow"',
    "cat <<EOF\n sudo rm -rf /\nEOF",
    'echo "sudo rm -rf /"',
    "mkfs --help",
    "mkfs.ext4 image.img",
    "dd if=/dev/sda of=backup.img",
    "dd if=iso of=/dev/null bs=4M",
  ])("does not floor-deny benign lookalike: %s", async (command) => {
    expect(await floorDecision(command)).toMatchObject({
      effect: "review",
      provenance: { source: "default" },
    });
  });
});

describe("sealed floor parser arg extraction", () => {
  it.each([
    ["rm -rf /", "/"],
    ["rm -rf -- /", "/"],
  ])("extracts arg0 for %s", async (command, expectedArg0) => {
    const [stage] = commandStages(await bash(command));

    expect(stage?.program.program).toBe("rm");
    expect(stage?.program.arguments[0]).toBe(expectedArg0);
  });
});

describe("sealed floor corpus replay", () => {
  it("denies the single-stage root-delete hard_block row", async () => {
    expectFloorDeny(
      await floorDecision(hardBlockCommand("rm -rf -- /")),
      "floor:deny-rm-system-root",
    );
  });

  it("denies graduated device-destruction hard_block rows", async () => {
    expectFloorDeny(
      await floorDecision(
        hardBlockCommand("dd of=/dev/sda if=/dev/zero bs=1M"),
      ),
      "floor:deny-dd-device-write",
    );
    expectFloorDeny(
      await floorDecision(hardBlockCommand("mkfs -t ext4 /dev/sda")),
      "floor:deny-mkfs-device",
    );
  });

  it("denies catastrophic stages hidden in composed commands", async () => {
    for (const command of [
      hardBlockCommand(".work/bin/work-view --ready && rm -rf -- /"),
      hardBlockCommand("git status --short; rm -rf -- /"),
      "git log | head -5 && rm -rf /",
      "git status && rm -rf -- /",
      "sudo ls | head || true",
      "git log\nsudo ls",
      "for f in *; do rm -rf /; done",
    ]) {
      const ruleId = command.includes("sudo")
        ? "floor:deny-privilege-escalation"
        : "floor:deny-rm-system-root";
      expectFloorDeny(await floorDecision(command), ruleId);
    }
  });
});
