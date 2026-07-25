import type { EffectivePolicy } from "../../policy/core.ts";
import type { CorpusEntry, ReplayCorpus } from "../../replay/history.ts";
import {
  effectToStatus,
  type RatchetReport,
  type ReplayBashParser,
  type ReplayStatus,
  replayHistory,
} from "../../replay/ratchet.ts";
import { renderRatchetMarkdown } from "../../replay/ratchet-markdown.ts";

export type FixtureExpected = "fast_path" | "review" | "hard_block";

export interface FixtureRegression {
  readonly command: string;
  readonly expected: FixtureExpected;
  readonly actual: ReplayStatus;
  readonly severity: "hard" | "soft";
  readonly reason: string;
}

export interface VerificationResult {
  readonly report: RatchetReport;
  readonly markdown: string;
  readonly fixtureRegressions: readonly FixtureRegression[];
  readonly fixtureChecked: number;
  readonly expansions: { readonly calls: number; readonly unique: number };
  readonly ok: boolean;
  readonly warnings: readonly string[];
}

interface VerifyAfterWriteOptions {
  readonly bashParser?: ReplayBashParser;
  readonly clock?: () => Date;
}

interface VerifyFixturesOptions {
  readonly bashParser?: ReplayBashParser;
}

interface FixtureVerification {
  readonly regressions: readonly FixtureRegression[];
  readonly checked: number;
  readonly warnings: readonly string[];
}

/** Post-write verification: compare + fixture regressions. Pure (injected parser). */
export async function verifyAfterWrite(
  userCorpus: ReplayCorpus,
  fixtureCorpus: ReplayCorpus,
  beforePolicy: EffectivePolicy,
  afterPolicy: EffectivePolicy,
  options?: VerifyAfterWriteOptions,
): Promise<VerificationResult> {
  const report = await replayHistory(userCorpus, beforePolicy, {
    proposedPolicy: afterPolicy,
    ...(options?.clock === undefined ? {} : { clock: options.clock }),
  });
  const fixtureOptions =
    options?.bashParser === undefined
      ? undefined
      : { bashParser: options.bashParser };
  const fixture = await runFixtureVerification(
    fixtureCorpus,
    afterPolicy,
    fixtureOptions,
  );
  const beforeStatuses = await fixtureStatusByCommand(
    fixtureCorpus,
    beforePolicy,
    fixtureOptions,
  );
  const regressions = fixture.regressions.map((regression) =>
    softenPreexistingHardRegression(regression, beforeStatuses),
  );
  const hardRegressions = regressions.filter(
    (regression) => regression.severity === "hard",
  );

  return {
    report,
    markdown: renderRatchetMarkdown(report),
    fixtureRegressions: regressions,
    fixtureChecked: fixture.checked,
    expansions: report.compare?.expansions ?? { calls: 0, unique: 0 },
    ok: hardRegressions.length === 0,
    warnings: [...report.corpus.warnings, ...fixture.warnings],
  };
}

/** Check shipped fixtures for regressions against a policy. Pure helper. */
export async function verifyFixtures(
  fixtureCorpus: ReplayCorpus,
  policy: EffectivePolicy,
  options?: VerifyFixturesOptions,
): Promise<readonly FixtureRegression[]> {
  const verification = await runFixtureVerification(
    fixtureCorpus,
    policy,
    options,
  );
  return verification.regressions;
}

async function runFixtureVerification(
  fixtureCorpus: ReplayCorpus,
  policy: EffectivePolicy,
  _options?: VerifyFixturesOptions,
): Promise<FixtureVerification> {
  const report = await replayHistory(fixtureCorpus, policy);
  const statusByCommand = statusMapFromReport(report);
  const expectedRows = fixtureExpectedRows(fixtureCorpus.entries);

  return {
    regressions: expectedRows.flatMap((entry) => {
      const actual = statusByCommand.get(entry.command);
      if (actual === undefined) {
        return [missingReplayRowRegression(entry)];
      }

      return actual === expectedToStatus(entry.expectedLabel)
        ? []
        : [fixtureRegression(entry.command, entry.expectedLabel, actual)];
    }),
    checked: expectedRows.length,
    warnings: report.corpus.warnings,
  };
}

async function fixtureStatusByCommand(
  fixtureCorpus: ReplayCorpus,
  policy: EffectivePolicy,
  _options?: VerifyFixturesOptions,
): Promise<ReadonlyMap<string, ReplayStatus>> {
  const report = await replayHistory(fixtureCorpus, policy);
  return statusMapFromReport(report);
}

function statusMapFromReport(
  report: RatchetReport,
): ReadonlyMap<string, ReplayStatus> {
  return new Map(
    report.perCommand.map((row) => [row.command, row.status] as const),
  );
}

function softenPreexistingHardRegression(
  regression: FixtureRegression,
  beforeStatuses: ReadonlyMap<string, ReplayStatus>,
): FixtureRegression {
  // The shipped fixture corpus can contain known baseline drift. An apply run
  // should fail on newly introduced hard widenings, not on a hard mismatch that
  // already existed before the approved proposal was written.
  if (regression.severity !== "hard") {
    return regression;
  }

  const beforeStatus = beforeStatuses.get(regression.command);
  if (beforeStatus !== regression.actual) {
    return regression;
  }

  return {
    ...regression,
    severity: "soft",
    reason: `${regression.reason} (pre-existing before this apply run)`,
  };
}

function fixtureExpectedRows(
  entries: readonly CorpusEntry[],
): readonly (CorpusEntry & { readonly expectedLabel: FixtureExpected })[] {
  return entries.filter(
    (
      entry,
    ): entry is CorpusEntry & { readonly expectedLabel: FixtureExpected } =>
      entry.expectedLabel !== undefined,
  );
}

function expectedToStatus(expected: FixtureExpected): ReplayStatus {
  switch (expected) {
    case "fast_path":
      return effectToStatus("allow");
    case "review":
      return effectToStatus("review");
    case "hard_block":
      return effectToStatus("deny");
  }
}

function missingReplayRowRegression(entry: {
  readonly command: string;
  readonly expectedLabel: FixtureExpected;
}): FixtureRegression {
  return {
    command: entry.command,
    expected: entry.expectedLabel,
    actual: "review",
    severity: "soft",
    reason:
      "fixture carried an expected label but replay produced no matching command row",
  };
}

function fixtureRegression(
  command: string,
  expected: FixtureExpected,
  actual: ReplayStatus,
): FixtureRegression {
  const severity = regressionSeverity(expected, actual);
  return {
    command,
    expected,
    actual,
    severity,
    reason: regressionReason(expected, actual, severity),
  };
}

function regressionSeverity(
  expected: FixtureExpected,
  actual: ReplayStatus,
): FixtureRegression["severity"] {
  return expected === "hard_block" && actual === "fast_path" ? "hard" : "soft";
}

function regressionReason(
  expected: FixtureExpected,
  actual: ReplayStatus,
  severity: FixtureRegression["severity"],
): string {
  if (severity === "hard") {
    return `fixture expected ${expected} but replay widened it to ${actual}`;
  }

  return `fixture expected ${expected} but replay returned ${actual}`;
}
