/**
 * Test-local path-scoped constructive policy fixture.
 *
 * This pack proves the inspectable path-scope matcher DSL end-to-end without
 * touching the shipped `bash.project.constructive` pack. The shipped pack's
 * migration to these predicates is owned by the next feature
 * (`epic-path-scoped-policy-baseline-baseline-pack-cleanup`); this fixture only
 * demonstrates the matcher behavior that will close the shipped locality gap.
 *
 * The three constructive allow rules (`touch`, `mkdir`, `mktemp`) all require
 * every command stage to be covered by an enriched, in-scope path fact
 * (`requireFacts: "per-command-stage"` with a `programs` coverage guard) and
 * every selected fact's winning scope to be project/temp. The `mkdir -m` review
 * rule proves effect precedence: `review > allow` even when the path-scoped
 * allow also matches.
 */
import { defineShippedPack } from "../../src/packs/define.ts";
import { sealedFloor } from "../../src/packs/floor.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import {
  attachBashPathFacts,
  enrichToolShapeWithPathFacts,
  type PathFactProjectScope,
} from "../../src/parse/native-path-facts.ts";
import type { BashCommandShape, ToolShape } from "../../src/parse/shape.ts";
import type { Decision } from "../../src/policy/core.ts";
import { decide } from "../../src/policy/core.ts";
import { defaultResolvedProjectScope } from "./resolved-config.ts";

/** Scopes a constructive allow treats as safe project/temp containment. */
export const CONSTRUCTIVE_SCOPES = [
  "writable-project",
  "project",
  "temp",
] as const;

/** Constructive programs the fixture path-scoped allows cover. */
export const CONSTRUCTIVE_PROGRAMS = ["touch", "mkdir", "mktemp"] as const;

/**
 * Build a path-scoped constructive allow rule for one program. Mirrors the
 * recommended pack-authoring snippet: structural safety sentinels
 * (`noSubstitution`, `noStdoutRedirect`) plus `pathScopesAllIn` with
 * `requireFacts: "per-command-stage"` and a `programs` coverage guard so a
 * missing or unextracted operand can never satisfy the allow.
 */
function constructiveAllowRule(programName: string) {
  return {
    id: `fixture:allow-${programName}-project-temp`,
    effect: "allow" as const,
    match: {
      all: [
        { program: programName },
        { noSubstitution: true },
        { noStdoutRedirect: true },
        {
          pathScopesAllIn: {
            scopes: [...CONSTRUCTIVE_SCOPES],
            programs: [programName],
            requireFacts: "per-command-stage",
          },
        },
      ],
    },
    reason: `${programName} within configured project/temp path scope`,
    provenance: { source: "shipped" as const },
  };
}

const rawPathScopedConstructivePack = {
  version: 1,
  id: "fixture.path-scoped-constructive",
  rules: [
    {
      id: "fixture:review-mkdir-mode",
      effect: "review",
      match: {
        all: [
          { program: "mkdir" },
          { any: [{ flagPresent: "m" }, { flagPresent: "mode" }] },
        ],
      },
      reason: "mkdir mode changes permission semantics and requires review",
      provenance: { source: "shipped" },
    },
    ...CONSTRUCTIVE_PROGRAMS.map(constructiveAllowRule),
  ],
};

/**
 * Compiled fixture pack. `defineShippedPack` fails fast if the JSON pack drifts
 * out of the DSL, so a broken fixture surfaces immediately rather than silently
 * degrading to structural matching.
 */
export const fixturePathScopedConstructivePack = defineShippedPack(
  rawPathScopedConstructivePack,
);

/** Default fixture working directory: `/repo` is both a root and writable. */
export const FIXTURE_CWD = "/repo";

/** Default fixture temp directory, distinct from system roots. */
export const FIXTURE_TEMP_DIR = "/tmp/os-tmp";

export interface FixtureScopeOptions {
  readonly cwd?: string;
  readonly roots?: readonly string[];
  readonly writableDirectories?: readonly string[];
  readonly tempDirectories?: readonly string[];
  readonly deniedDirectories?: readonly string[];
  /**
   * Optional home directory. The runtime seam
   * `enrichToolShapeWithPathFacts` intentionally does not plumb this, so runtime
   * `~/...` operands stay fail-closed `unknown`. Supplying it here exercises the
   * genuine `home`-scope rejection path the runtime will reach once the
   * `homeDirectory` follow-up lands.
   */
  readonly homeDirectory?: string;
}

/**
 * Build a `PathFactProjectScope` for fixture enrichment. Defaults to `/repo`
 * (root + writable) with `/tmp/os-tmp` as temp; callers override per-case
 * (e.g. a denied directory) via {@link FixtureScopeOptions}.
 */
export function fixtureProjectScope(
  overrides: FixtureScopeOptions = {},
): PathFactProjectScope {
  return {
    ...defaultResolvedProjectScope(),
    roots: overrides.roots ?? [FIXTURE_CWD],
    writableDirectories: overrides.writableDirectories ?? [FIXTURE_CWD],
    tempDirectories: overrides.tempDirectories ?? [FIXTURE_TEMP_DIR],
    ...(overrides.deniedDirectories !== undefined
      ? { deniedDirectories: overrides.deniedDirectories }
      : {}),
  };
}

/**
 * Enrich a parsed shape with path facts under the fixture scope. Routes through
 * `attachBashPathFacts` (the lower-level seam that accepts `homeDirectory`) only
 * when a home directory is supplied; otherwise uses the real runtime seam
 * `enrichToolShapeWithPathFacts`, which does not plumb `homeDirectory` — so the
 * default path reflects actual runtime behavior and the `~/...` gap stays
 * visible.
 */
export function enrichFixtureShape(
  shape: ToolShape,
  options: FixtureScopeOptions = {},
): ToolShape {
  const cwd = options.cwd ?? FIXTURE_CWD;
  const projectScope = fixtureProjectScope(options);
  if (options.homeDirectory !== undefined) {
    return attachBashPathFacts(shape, {
      cwd,
      projectScope,
      homeDirectory: options.homeDirectory,
    });
  }
  return enrichToolShapeWithPathFacts(shape, { cwd, projectScope });
}

/** Parse + enrich a bash command under the fixture scope, asserting bash. */
export async function enrichFixtureBash(
  command: string,
  options: FixtureScopeOptions = {},
): Promise<BashCommandShape> {
  const shape = await analyzeBashCommand(command);
  const enriched = enrichFixtureShape(shape, options);
  if (enriched.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  return enriched;
}

/**
 * End-to-end fixture decision: parse, enrich under the fixture project scope,
 * and decide against the sealed floor plus the fixture path-scoped constructive
 * pack. This is the same shape the runtime policy interpreter evaluates, so
 * allow/reject/review/deny outcomes here are real policy decisions.
 */
export async function decideFixture(
  command: string,
  options: FixtureScopeOptions = {},
): Promise<Decision> {
  const shape = await analyzeBashCommand(command);
  const enriched = enrichFixtureShape(shape, options);
  return decide(enriched, {
    floor: sealedFloor.rules,
    active: fixturePathScopedConstructivePack.rules,
  });
}
