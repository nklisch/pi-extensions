import { describe, expect, it } from "vitest";

import type { ResolvedProjectScope } from "../../src/config/loader.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import { enrichToolShapeWithPathFacts } from "../../src/parse/native-path-facts.ts";
import type { ToolShape } from "../../src/parse/shape.ts";
import { loadEffectivePolicy } from "../../src/policy/loader.ts";
import { compilePack, decide } from "../../src/policy/core.ts";
import {
  buildScopeBehaviorPack,
  SCOPE_BEHAVIOR_PACK_ID,
} from "../../src/policy/scope-behavior-pack.ts";
import { bashInspectCorePack } from "../../src/packs/bash.inspect.core.ts";
import { sealedFloor } from "../../src/packs/floor.ts";

function scope(
  overrides: Partial<ResolvedProjectScope> = {},
): ResolvedProjectScope {
  return {
    roots: ["/repo"],
    writableDirectories: ["/repo"],
    tempDirectories: ["/tmp"],
    deniedDirectories: [],
    safeHomeDirectories: [],
    agentSupportDirectories: [],
    unknownPathBehavior: "review",
    sensitivePathBehavior: "review",
    homePathBehavior: "allow",
    ...overrides,
  };
}

async function bashShape(
  command: string,
  projectScope: ResolvedProjectScope,
): Promise<ToolShape> {
  const parsed = await analyzeBashCommand(command);
  return enrichToolShapeWithPathFacts(parsed, {
    cwd: "/repo",
    projectScope,
    ...(process.env.HOME === undefined
      ? {}
      : { homeDirectory: process.env.HOME }),
  });
}

function policyWith(
  projectScope: ResolvedProjectScope,
  extraPacks: readonly (typeof bashInspectCorePack)[] = [bashInspectCorePack],
) {
  const scopePack = buildScopeBehaviorPack(projectScope);
  if (!scopePack.ok) throw new Error("scope pack failed to compile");
  const loaded = loadEffectivePolicy({
    floor: sealedFloor,
    active: [
      ...extraPacks,
      ...(scopePack.pack === null ? [] : [scopePack.pack]),
    ],
  });
  if (!loaded.ok) throw new Error("policy failed to load");
  return loaded.policy;
}

describe("buildScopeBehaviorPack", () => {
  it("always emits the unknown/sensitive ceilings, even at defaults", () => {
    const result = buildScopeBehaviorPack(scope());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack).not.toBeNull();
    expect(result.pack?.rules.map((rule) => rule.effect).sort()).toEqual([
      "review",
      "review",
    ]);
  });

  it("denies commands touching configured denied directories", async () => {
    const projectScope = scope({ deniedDirectories: ["/repo/secrets"] });
    const shape = await bashShape("cat /repo/secrets/key.pem", projectScope);
    const decision = decide(shape, policyWith(projectScope));

    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("denied director");
    expect(decision.provenance.source).toBe("generated");
  });

  it("deny on denied directories outranks baseline read allows", async () => {
    const projectScope = scope({ deniedDirectories: ["/repo/secrets"] });
    const shape = await bashShape("cat /repo/secrets/key.pem", projectScope);

    // Without the derived pack the denied scope satisfies no allow rule, so
    // this used to fall through to review — the gap this pack closes.
    const withoutPack = decide(
      shape,
      policyWith(scope({ deniedDirectories: [] })),
    );
    expect(withoutPack.effect).toBe("review");

    const withPack = decide(shape, policyWith(projectScope));
    expect(withPack.effect).toBe("deny");
  });

  it("denies unknown paths only when unknownPathBehavior is deny", async () => {
    const projectScope = scope({ unknownPathBehavior: "deny" });
    const shape = await bashShape("cat $DYNAMIC_TARGET", projectScope);
    expect(shape.kind).toBe("bash");
    if (shape.kind !== "bash") return;
    expect(shape.pathFacts?.hasUnknown).toBe(true);

    const decision = decide(shape, policyWith(projectScope));
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("unknownPathBehavior");

    const reviewScope = scope({ unknownPathBehavior: "review" });
    const reviewDecision = decide(
      await bashShape("cat $DYNAMIC_TARGET", reviewScope),
      policyWith(reviewScope),
    );
    expect(reviewDecision.effect).not.toBe("deny");
  });

  it("denies sensitive home paths when sensitivePathBehavior is deny", async () => {
    const home = process.env.HOME;
    expect(home).toBeDefined();
    const projectScope = scope({ sensitivePathBehavior: "deny" });
    const shape = await bashShape(`cat ${home}/.ssh/id_rsa`, projectScope);

    const decision = decide(shape, policyWith(projectScope));
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("sensitive home");
  });

  it("keeps sensitive home paths review-gated by default", async () => {
    const home = process.env.HOME;
    const projectScope = scope();
    const shape = await bashShape(`cat ${home}/.ssh/id_rsa`, projectScope);

    const decision = decide(shape, policyWith(projectScope));
    expect(decision.effect).not.toBe("deny");
  });

  it("gates baseline home read allows when homePathBehavior is review", async () => {
    const home = process.env.HOME;
    const projectScope = scope({ homePathBehavior: "review" });
    const shape = await bashShape(`cat ${home}/notes.txt`, projectScope);

    // Baseline alone allows home reads.
    const baselineDecision = decide(shape, policyWith(scope()));
    expect(baselineDecision.effect).toBe("allow");

    const decision = decide(shape, policyWith(projectScope));
    expect(decision.effect).toBe("review");
    expect(decision.reason).toContain("project-only scope");
  });

  it("leaves project-local reads allowed under homePathBehavior review", async () => {
    const projectScope = scope({ homePathBehavior: "review" });
    const shape = await bashShape("cat /repo/README.md", projectScope);

    const decision = decide(shape, policyWith(projectScope));
    expect(decision.effect).toBe("allow");
  });

  it("gives the derived pack a stable id", () => {
    const result = buildScopeBehaviorPack(
      scope({ deniedDirectories: ["/repo/secrets"] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack?.id).toBe(SCOPE_BEHAVIOR_PACK_ID);
  });

  it("review-ceiling on sensitive home blocks user-authored allow rules", async () => {
    const home = process.env.HOME;
    const projectScope = scope();
    const shape = await bashShape(`cat ${home}/.ssh/id_rsa`, projectScope);

    // A user allow that matches sensitive-home facts loses to the ceiling.
    const userAllow = compilePack({
      version: 1,
      id: "user.allow-everything",
      rules: [
        {
          id: "user.allow-everything:allow-cat",
          effect: "allow",
          match: { program: "cat" },
          reason: "user trusts cat everywhere",
          provenance: { source: "user-global" },
        },
      ],
    });
    expect(userAllow.pack).not.toBeNull();
    if (userAllow.pack === null) return;

    const decision = decide(
      shape,
      policyWith(projectScope, [bashInspectCorePack, userAllow.pack]),
    );
    expect(decision.effect).toBe("review");
    expect(decision.reason).toContain("never auto-clears");
  });
});
