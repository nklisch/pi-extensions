#!/usr/bin/env node
"use strict";

// Internal development helper for the ratchet test/debug harness.
//
// This wrapper lives under scripts/dev/ so it is NOT published as a package
// executable (package.json has no `bin` and `files` excludes scripts/). It
// drives `runRatchetCli()` from `src/skill/clearance-tune/cli.ts` so
// maintainers can exercise the replay/presentation/write-plan/verification
// modules from a terminal during tests and debugging. It is not the supported
// approval path: the maintained product workflow is Pi-native Tune mode —
// `/clearance tune` with the temporary `clearance_*` tools, then `/clearance tune`
// again to turn them off. Structured proposal objects remain the source of truth;
// helper markdown is presentation only.

const { createJiti } = require("jiti");

const jiti = createJiti(__filename, { interopDefault: true });
const { runRatchetCli } = jiti(
  "../../src/skill/clearance-tune/cli.ts",
);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

runRatchetCli(process.argv.slice(2)).then(
  (result) => {
    if (result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    process.exitCode = result.exitCode;
  },
  (error) => {
    process.stdout.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  },
);
