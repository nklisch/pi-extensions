import { expect } from "vitest";
import { sealedFloor } from "../../src/packs/floor.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import { enrichToolShapeWithPathFacts } from "../../src/parse/native-path-facts.ts";
import type { PolicyPack } from "../../src/policy/core.ts";
import { decide } from "../../src/policy/core.ts";
import { loadEffectivePolicy } from "../../src/policy/loader.ts";
import { fixtureProjectScope } from "../fixtures/path-scoped-constructive-pack.ts";

export async function decideWithPacks(
  command: string,
  packs: readonly PolicyPack[],
) {
  const parsed = await analyzeBashCommand(command);
  // Enrich under the standard fixture scope (/repo project + /tmp temp) so
  // path-scoped allow rules see the same facts they see in production.
  const shape = enrichToolShapeWithPathFacts(parsed, {
    cwd: "/repo",
    projectScope: fixtureProjectScope(),
  });
  return decide(shape, {
    floor: sealedFloor.rules,
    active: packs.flatMap((pack) => [...pack.rules]),
  });
}

export function expectCleanLoad(pack: PolicyPack): void {
  expectCleanLoadAll([pack]);
}

export function expectCleanLoadAll(packs: readonly PolicyPack[]): void {
  expect(loadEffectivePolicy({ floor: sealedFloor, active: packs })).toEqual({
    ok: true,
    policy: {
      floor: sealedFloor.rules,
      active: packs.flatMap((pack) => [...pack.rules]),
    },
    warnings: [],
  });
}

export async function expectDecisionEffect(
  command: string,
  pack: PolicyPack,
  effect: "allow" | "deny" | "review",
): Promise<void> {
  expect(await decideWithPacks(command, [pack])).toMatchObject({ effect });
}

export async function expectAllowFromPack(
  command: string,
  pack: PolicyPack,
  packId: string,
): Promise<void> {
  expect(await decideWithPacks(command, [pack])).toMatchObject({
    effect: "allow",
    provenance: { source: "shipped", packId },
  });
}
