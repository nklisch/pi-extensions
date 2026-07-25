import { describe, expect, it } from "vitest";

import { baselinePacks } from "../../src/packs/baseline.ts";
import { sealedFloor } from "../../src/packs/floor.ts";
import { enrichToolShapeWithPathFacts } from "../../src/parse/native-path-facts.ts";
import { createDefaultAnalyzerRegistry } from "../../src/parse/registry.ts";
import type { ToolShape } from "../../src/parse/shape.ts";
import { decide } from "../../src/policy/core.ts";

const registry = createDefaultAnalyzerRegistry();
const active = baselinePacks.flatMap((pack) => pack.rules);
const projectScope = {
  roots: ["/repo"],
  writableDirectories: ["/repo"],
  tempDirectories: ["/tmp"],
  deniedDirectories: [],
  safeHomeDirectories: [],
  unknownPathBehavior: "review" as const,
};

async function embedded(
  toolName: "background" | "monitor",
  input: unknown,
  cwd = "/repo",
): Promise<ToolShape> {
  const raw = await registry.analyze(toolName, input);
  return enrichToolShapeWithPathFacts(raw, { cwd, projectScope });
}

function decideEmbedded(shape: ToolShape) {
  return decide(shape, { floor: sealedFloor.rules, active });
}

describe("embedded shell Pi-tool projection", () => {
  it("runs an allowed inner command through the normal bash policy", async () => {
    const shape = await embedded("background", { command: "pnpm test" });

    expect(decideEmbedded(shape)).toMatchObject({
      effect: "allow",
      provenance: { packId: "bash.dev.verify" },
    });
    expect(shape).toMatchObject({
      kind: "pi-tool",
      embeddedShell: {
        command: { kind: "bash", rawCommand: "pnpm test" },
      },
    });
  });

  it("keeps an uncertain inner command on the review path", async () => {
    const shape = await embedded("monitor", { command: "git push" });

    expect(decideEmbedded(shape)).toMatchObject({
      effect: "review",
      provenance: {
        packId: "pi.extension.review-boundaries",
        ruleId:
          "pi.extension.review-boundaries:review-embedded-shell-and-agent-dispatch",
      },
    });
  });

  it("applies the sealed floor to the projected inner command", async () => {
    const shape = await embedded("background", {
      command: "sudo rm -rf /",
    });

    expect(decideEmbedded(shape)).toMatchObject({
      effect: "deny",
      provenance: {
        packId: "floor.deny",
        ruleId: "floor:deny-privilege-escalation",
      },
    });
  });

  it("lets a valid timeout and project working directory accompany an allow", async () => {
    for (const toolName of ["background", "monitor"] as const) {
      const shape = await embedded(toolName, {
        command: "pnpm test",
        timeout: 30_000,
        workingDirectory: "/repo/packages",
      });

      expect(decideEmbedded(shape)).toMatchObject({ effect: "allow" });
      expect(shape).toMatchObject({
        pathFacts: {
          facts: [
            expect.objectContaining({
              raw: "/repo/packages",
              scope: "writable-project",
            }),
          ],
        },
        embeddedShell: {
          workingDirectoryFact: expect.objectContaining({
            scope: "writable-project",
          }),
          command: {
            pathFacts: { baseCwd: "/repo/packages" },
          },
        },
      });
    }
  });

  it("reviews unsafe or malformed wrapper fields", async () => {
    const shapes = await Promise.all([
      embedded("background", { command: "pnpm test", timeout: -1 }),
      embedded("background", {
        command: "pnpm test",
        workingDirectory: "/etc",
      }),
      embedded("monitor", { command: "pnpm test", unexpected: true }),
      embedded("monitor", { command: 42 }),
      embedded("background", {}),
    ]);

    for (const shape of shapes) {
      expect(decideEmbedded(shape)).toMatchObject({ effect: "review" });
    }
  });

  it("keeps the floor ahead of an unsafe wrapper cwd", async () => {
    const shape = await embedded("background", {
      command: "sudo rm -rf /",
      workingDirectory: "/etc",
    });

    expect(decideEmbedded(shape)).toMatchObject({
      effect: "deny",
      provenance: { packId: "floor.deny" },
    });
  });

  it("uses the review-boundary rule only as the projection fallback", async () => {
    const allowed = await embedded("background", { command: "pnpm test" });
    const malformed = await embedded("background", {});

    expect(decideEmbedded(allowed).provenance.packId).toBe("bash.dev.verify");
    expect(decideEmbedded(malformed).provenance).toMatchObject({
      packId: "pi.extension.review-boundaries",
    });
  });
});
