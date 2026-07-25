import { describe, expect, it } from "vitest";
import { sealedFloor } from "../../src/packs/floor.ts";
import { compilePack } from "../../src/policy/core.ts";
import { loadEffectivePolicy } from "../../src/policy/loader.ts";

type RuleInput = {
  readonly id: string;
  readonly effect: "allow" | "deny" | "review";
  readonly match: unknown;
  readonly reason?: string;
};

function compilePackOrThrow(id: string, rules: readonly RuleInput[]) {
  const result = compilePack({
    version: 1,
    id,
    rules: rules.map((rule) => ({
      id: rule.id,
      effect: rule.effect,
      match: rule.match,
      reason: rule.reason ?? rule.id,
      provenance: { source: "shipped" },
    })),
  });

  if (result.pack === null) {
    throw new Error(JSON.stringify(result.errors));
  }

  return result.pack;
}

function errorMessagesFor(packRules: readonly RuleInput[]) {
  const pack = compilePackOrThrow("test.allow", packRules);
  const result = loadEffectivePolicy({ floor: sealedFloor, active: [pack] });

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected load failure");
  }

  return result.errors.map((error) => error.message);
}

describe("sealed floor disjointness", () => {
  it("loads ordinary program-anchored read-only allows cleanly", () => {
    const readOnly = compilePackOrThrow("test.read-only", [
      {
        id: "allow:git-read-only",
        effect: "allow",
        match: {
          all: [
            { program: "git" },
            { noSubstitution: true },
            { noStdoutRedirect: true },
          ],
        },
      },
      {
        id: "allow:ls-read-only",
        effect: "allow",
        match: {
          all: [
            { program: "ls" },
            { noSubstitution: true },
            { noStdoutRedirect: true },
          ],
        },
      },
    ]);

    expect(
      loadEffectivePolicy({ floor: sealedFloor, active: [readOnly] }),
    ).toEqual({
      ok: true,
      policy: { floor: sealedFloor.rules, active: readOnly.rules },
      warnings: [],
    });
  });

  it("rejects an allow overlapping the system-root deletion floor rule", () => {
    expect(
      errorMessagesFor([
        {
          id: "allow:root-rm",
          effect: "allow",
          match: {
            all: [{ program: "rm" }, { arg0In: ["/", "/etc"] }],
          },
        },
      ]),
    ).toContain(
      "allow rule overlaps sealed-floor deny `floor:deny-rm-system-root`",
    );
  });

  it("rejects an allow overlapping the privilege-escalation floor rule", () => {
    expect(
      errorMessagesFor([
        {
          id: "allow:sudo",
          effect: "allow",
          match: { program: "sudo" },
        },
      ]),
    ).toContain(
      "allow rule overlaps sealed-floor deny `floor:deny-privilege-escalation`",
    );
  });

  it("rejects a dd device allow without a second disjointness witness", () => {
    expect(
      errorMessagesFor([
        {
          id: "allow:dd-device",
          effect: "allow",
          match: {
            all: [{ program: "dd" }, { anyArgMatches: "^of=img$" }],
          },
        },
      ]),
    ).toContain(
      "allow rule overlaps sealed-floor deny `floor:deny-dd-device-write`",
    );
  });

  it("rejects allow-side stageSome as undecidable", () => {
    expect(
      errorMessagesFor([
        {
          id: "allow:any-stage-git",
          effect: "allow",
          match: { stageSome: { program: "git" } },
        },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "allow rule has undecidable overlap with sealed-floor deny `floor:deny-rm-system-root`",
        ),
      ]),
    );
  });

  it("keeps systemctl status allows unloadable without a second witness", () => {
    expect(
      errorMessagesFor([
        {
          id: "allow:systemctl-status",
          effect: "allow",
          match: {
            all: [{ program: "systemctl" }, { arg0In: ["status"] }],
          },
        },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "allow rule overlaps sealed-floor deny `floor:deny-system-shutdown`",
        ),
      ]),
    );
  });

  it("loads a narrow rm allow whose arg0 set is disjoint from the floor", () => {
    const narrowRm = compilePackOrThrow("test.narrow-rm", [
      {
        id: "allow:rm-build",
        effect: "allow",
        match: {
          all: [{ program: "rm" }, { arg0In: ["build"] }],
        },
      },
    ]);

    expect(
      loadEffectivePolicy({ floor: sealedFloor, active: [narrowRm] }),
    ).toEqual({
      ok: true,
      policy: { floor: sealedFloor.rules, active: narrowRm.rules },
      warnings: [],
    });
  });

  it("loads a path-scoped constructive allow disjoint from the sealed floor", () => {
    const pathScoped = compilePackOrThrow("test.path-scoped", [
      {
        id: "allow:touch-project-temp",
        effect: "allow",
        match: {
          all: [
            { program: "touch" },
            { noSubstitution: true },
            { noStdoutRedirect: true },
            {
              pathScopesAllIn: {
                scopes: ["writable-project", "project", "temp"],
                programs: ["touch"],
                requireFacts: "per-command-stage",
              },
            },
          ],
        },
      },
    ]);

    expect(
      loadEffectivePolicy({ floor: sealedFloor, active: [pathScoped] }),
    ).toEqual({
      ok: true,
      policy: { floor: sealedFloor.rules, active: pathScoped.rules },
      warnings: [],
    });
  });

  it("loads a shipped-style mutation allow because mutationTool anchors overlap", () => {
    const mutationPack = compilePackOrThrow("test.mutation", [
      {
        id: "allow:project-mutation",
        effect: "allow",
        match: {
          all: [
            { mutationTool: { tools: ["edit", "write"] } },
            { mutationShape: { shape: "well-formed" } },
            {
              pathScopesAllIn: {
                scopes: ["writable-project", "project"],
                requireFacts: "one-or-more",
              },
            },
            { mutationTrustBoundary: { in: ["none"] } },
          ],
        },
      },
    ]);

    expect(
      loadEffectivePolicy({ floor: sealedFloor, active: [mutationPack] }),
    ).toEqual({
      ok: true,
      policy: { floor: sealedFloor.rules, active: mutationPack.rules },
      warnings: [],
    });
  });

  it("rejects mutation refiners without a concrete mutation tool anchor", () => {
    expect(
      errorMessagesFor([
        {
          id: "allow:unanchored-mutation-refiners",
          effect: "allow",
          match: {
            all: [
              { mutationShape: { shape: "well-formed" } },
              { mutationTrustBoundary: { in: ["none"] } },
            ],
          },
        },
      ]),
    ).toContain(
      "allow rule has undecidable overlap with sealed-floor deny `floor:deny-rm-system-root`; refine the matcher to be provably disjoint",
    );
  });

  it("keeps the shipped floor compiled as deny-only shipped provenance", () => {
    expect(sealedFloor.rules).toHaveLength(5);
    for (const rule of sealedFloor.rules) {
      expect(rule.effect).toBe("deny");
      expect(rule.provenance).toMatchObject({
        source: "shipped",
        packId: "floor.deny",
        ruleId: rule.id,
      });
    }
  });
});
