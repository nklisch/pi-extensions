import { describe, expect, it } from "vitest";
import { sealedFloor } from "../../src/packs/floor.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import type { BashCommandShape } from "../../src/parse/shape.ts";
import type {
  DecisionEffect,
  DecisionSource,
  PolicyPack,
  PolicyRule,
} from "../../src/policy/core.ts";
import {
  always,
  compilePack,
  decide,
  inspectable,
  type MatcherExpr,
  not,
  program,
} from "../../src/policy/core.ts";
import { loadEffectivePolicy } from "../../src/policy/loader.ts";
import type { FixtureRow } from "../fixtures/load.ts";
import { loadAllCorpus } from "../fixtures/load.ts";
import {
  decideFixture,
  fixturePathScopedConstructivePack,
} from "../fixtures/path-scoped-constructive-pack.ts";

async function bash(command: string): Promise<BashCommandShape> {
  const shape = await analyzeBashCommand(command);
  expect(shape.kind).toBe("bash");
  if (shape.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  return shape;
}

function rule(
  id: string,
  effect: DecisionEffect,
  options: {
    readonly match?: MatcherExpr;
    readonly source?: DecisionSource;
    readonly packId?: string;
    readonly reason?: string;
  } = {},
): PolicyRule {
  return {
    id,
    effect,
    match: inspectable(options.match ?? always()),
    reason: options.reason ?? `reason for ${id}`,
    provenance: {
      source: options.source ?? "shipped",
      ruleId: id,
      ...(options.packId === undefined ? {} : { packId: options.packId }),
    },
  };
}

function pack(id: string, rules: readonly PolicyRule[]): PolicyPack {
  return { version: 1, id, rules };
}

function compilePolicyPack(raw: unknown): PolicyPack {
  const result = compilePack(raw);
  expect(result.errors).toEqual([]);
  expect(result.pack).not.toBeNull();
  if (result.pack === null) {
    throw new Error("expected compiled pack");
  }
  return result.pack;
}

function loadOk(floor: PolicyPack, active: readonly PolicyPack[]) {
  const result = loadEffectivePolicy({ floor, active });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected load success");
  }
  return result;
}

function findDiagnosticCorpusRow(): FixtureRow {
  const row = loadAllCorpus()
    .flatMap((entry) => entry.rows)
    .find(
      (candidate) =>
        candidate.command.includes("cat <<'EOF'") ||
        candidate.command.includes("cat << 'EOF'"),
    );
  if (row === undefined) {
    throw new Error("expected heredoc diagnostic corpus row");
  }
  return row;
}

describe("synthetic policy scenarios", () => {
  it("lets a sealed-floor deny win while a disjoint allow applies elsewhere", async () => {
    const floor = compilePolicyPack({
      version: 1,
      id: "floor.synthetic",
      rules: [
        {
          id: "deny-rm",
          effect: "deny",
          match: { program: "rm" },
          reason: "sealed rm deny",
          provenance: { source: "shipped" },
        },
      ],
    });
    const active = compilePolicyPack({
      version: 1,
      id: "active.synthetic",
      rules: [
        {
          id: "allow-git",
          effect: "allow",
          match: { program: "git" },
          reason: "git inspection allowed",
          provenance: { source: "user-project" },
        },
      ],
    });
    const { policy } = loadOk(floor, [active]);

    expect(decide(await bash("rm -rf /"), policy)).toMatchObject({
      effect: "deny",
      provenance: {
        source: "shipped",
        packId: "floor.synthetic",
        ruleId: "deny-rm",
      },
    });
    expect(decide(await bash("git status"), policy)).toMatchObject({
      effect: "allow",
      provenance: {
        source: "user-project",
        packId: "active.synthetic",
        ruleId: "allow-git",
      },
    });
  });

  it("rejects overlapping allows at load time", () => {
    const result = loadEffectivePolicy({
      floor: pack("floor", [rule("deny-rm", "deny", { match: program("rm") })]),
      active: [
        pack("active", [rule("allow-rm", "allow", { match: program("rm") })]),
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected load failure");
    }
    expect(result.errors).toEqual([
      expect.objectContaining({
        packId: "active",
        ruleId: "allow-rm",
        message: "allow rule overlaps sealed-floor deny `deny-rm`",
      }),
    ]);
  });

  it("rejects undecidable overlap fail-closed", () => {
    const result = loadEffectivePolicy({
      floor: pack("floor", [rule("deny-rm", "deny", { match: program("rm") })]),
      active: [
        pack("active", [
          rule("allow-not-rm", "allow", { match: not(program("rm")) }),
        ]),
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected load failure");
    }
    expect(result.errors[0]).toMatchObject({
      packId: "active",
      ruleId: "allow-not-rm",
    });
    expect(result.errors[0]?.message).toContain("undecidable overlap");
  });

  it("keeps effect precedence absolute across declaration-order permutations", async () => {
    const shape = await bash("git status");
    const allow = rule("allow", "allow");
    const review = rule("review", "review");
    const deny = rule("deny", "deny");

    for (const rules of [
      [allow, review, deny],
      [deny, allow, review],
      [review, deny, allow],
    ]) {
      expect(decide(shape, { active: rules })).toMatchObject({
        effect: "deny",
        reason: "deny: reason for deny",
      });
    }
  });

  it("uses specificity only to select reason and provenance within the winning effect", async () => {
    const shape = await bash("git status");
    const broad = rule("allow-broad", "allow", { match: always() });
    const narrow = rule("allow-git", "allow", { match: program("git") });

    expect(decide(shape, { active: [broad, narrow] })).toMatchObject({
      effect: "allow",
      reason: "allow-git: reason for allow-git",
      provenance: { ruleId: "allow-git" },
    });
  });

  it("falls through to review when no active rule matches", async () => {
    expect(
      decide(await bash("git status"), {
        active: [rule("rm-only", "allow", { match: program("rm") })],
      }),
    ).toEqual({
      effect: "review",
      reason: "no matching rule",
      provenance: { source: "default" },
    });
  });

  it("routes corpus parse diagnostics to review unless a floor deny matches", async () => {
    const diagnosticShape = await bash(findDiagnosticCorpusRow().command);
    expect(diagnosticShape.diagnostics.length).toBeGreaterThan(0);

    expect(
      decide(diagnosticShape, { active: [rule("allow-any", "allow")] }),
    ).toMatchObject({
      effect: "review",
      provenance: { source: "default" },
    });
    expect(
      decide(diagnosticShape, {
        floor: [rule("deny-any", "deny")],
        active: [],
      }),
    ).toMatchObject({
      effect: "deny",
      reason: "deny-any: reason for deny-any",
    });
  });
});

// --- path-scoped constructive fixture policy ---------------------------------
//
// End-to-end proof that the inspectable path-scope matcher DSL produces real
// policy decisions. The fixture pack (`fixture.path-scoped-constructive`) is a
// test-local pack that keeps matcher behavior easy to exercise in isolation;
// the shipped `bash.project.constructive` pack now uses the same path-scope
// predicate shape.

describe("path-scoped constructive fixture policy", () => {
  it("loads cleanly against the sealed floor with no warnings", () => {
    expect(
      loadEffectivePolicy({
        floor: sealedFloor,
        active: [fixturePathScopedConstructivePack],
      }),
    ).toEqual({
      ok: true,
      policy: {
        floor: sealedFloor.rules,
        active: fixturePathScopedConstructivePack.rules,
      },
      warnings: [],
    });
  });

  it.each([
    ["touch README.md", "fixture:allow-touch-project-temp"],
    ["mkdir -p dist", "fixture:allow-mkdir-project-temp"],
    ["mktemp", "fixture:allow-mktemp-project-temp"],
    ["mktemp -p /tmp/os-tmp", "fixture:allow-mktemp-project-temp"],
    ["cd subdir && touch file", "fixture:allow-touch-project-temp"],
  ])("allows project/temp-scoped constructive command: %s", async (command, ruleId) => {
    expect(await decideFixture(command)).toMatchObject({
      effect: "allow",
      provenance: {
        source: "shipped",
        packId: "fixture.path-scoped-constructive",
        ruleId,
      },
    });
  });

  it.each([
    // system target — matcher rejects (no parse diagnostic).
    ["touch /etc/passwd", "system target"],
    // relative path that escapes the project root from cwd /repo.
    ["touch ../outside", "outside target (parent escape)"],
    // outside project; runtime seam has no homeDirectory so /home/... is outside.
    ["touch /home/user/file", "outside target (runtime home gap)"],
    // unknown/dynamic — glob and brace are matcher-rejected (no diagnostic).
    ["touch out*", "glob expansion (unknown)"],
    ["touch {a,b}", "brace expansion (unknown)"],
    // resolved-but-system cwd-prefix makes the whole envelope unsafe.
    ["cd /etc && touch /repo/file", "system cwd-prefix"],
    // unsafe stderr redirect target outside allowed scopes.
    ["touch file 2> /etc/log", "system redirect target"],
    // bare touch: no path fact, per-command-stage coverage fails.
    ["touch", "missing path fact"],
    // runtime ~/... stays unknown without homeDirectory (safe fail-closed gap).
    ["touch ~/file", "runtime ~/ unknown gap"],
    ["touch /srv/file", "outside target"],
  ])("reviews out-of-scope / unknown / unsafe shape via matcher: %s", async (command) => {
    expect(await decideFixture(command)).toMatchObject({
      effect: "review",
      reason: "no matching rule",
      provenance: { source: "default" },
    });
  });

  it.each([
    // dynamic expansion also carries a parse diagnostic, so it review-gates
    // before the active allow is even considered — fail-closed either way.
    ['touch "$OUT"', "dynamic expansion + parse diagnostic"],
    // unresolved cwd-prefix (cd to a dynamic value) also carries a diagnostic.
    ['cd "$DIR" && touch file', "unresolved cwd-prefix + parse diagnostic"],
  ])("reviews dynamic / unresolved-cwd shape via parse diagnostics: %s", async (command) => {
    expect(await decideFixture(command)).toMatchObject({
      effect: "review",
      reason: "parse diagnostics present",
      provenance: { source: "default" },
    });
  });

  it("reviews a denied-directory target via the matcher", async () => {
    expect(
      await decideFixture("touch /repo/denied/file", {
        deniedDirectories: ["/repo/denied"],
      }),
    ).toMatchObject({
      effect: "review",
      reason: "no matching rule",
      provenance: { source: "default" },
    });
  });

  it("reviews a home-scope target once homeDirectory is plumbed", async () => {
    // The runtime seam does not supply homeDirectory yet, so at runtime this
    // path classifies as `outside` (proven above). Supplying homeDirectory here
    // exercises the genuine `home`-scope rejection the runtime will reach once
    // the homeDirectory follow-up lands; the matcher still fails closed.
    expect(
      await decideFixture("touch /home/user/file", {
        homeDirectory: "/home/user",
      }),
    ).toMatchObject({
      effect: "review",
      reason: "no matching rule",
      provenance: { source: "default" },
    });
  });

  it("keeps sealed-floor deny precedence over the fixture allow", async () => {
    // `sudo touch file` parses as a single `sudo` stage (program sudo), so the
    // fixture touch allow cannot match (program guard is touch, and no path
    // facts are extracted for sudo). The sealed floor denies privilege
    // escalation regardless, so the decision is deny from the floor.
    const decision = await decideFixture("sudo touch file");
    expect(decision).toMatchObject({
      effect: "deny",
      provenance: {
        source: "shipped",
        packId: "floor.deny",
        ruleId: "floor:deny-privilege-escalation",
      },
    });
  });

  it("keeps review precedence over a matching path-scoped allow", async () => {
    // `mkdir -p dist` is allowed by the path-scoped mkdir allow (dist is
    // writable-project), proving the allow matches project-temp shapes.
    expect(await decideFixture("mkdir -p dist")).toMatchObject({
      effect: "allow",
      provenance: { ruleId: "fixture:allow-mkdir-project-temp" },
    });

    // `mkdir -m 777 dist` matches the SAME path-scoped allow (dist is still
    // writable-project), but the `mkdir -m` review rule also matches and wins by
    // effect precedence (review > allow).
    expect(await decideFixture("mkdir -m 777 dist")).toMatchObject({
      effect: "review",
      provenance: {
        source: "shipped",
        packId: "fixture.path-scoped-constructive",
        ruleId: "fixture:review-mkdir-mode",
      },
    });
  });
});
