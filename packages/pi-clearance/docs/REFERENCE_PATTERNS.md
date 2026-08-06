# REFERENCE PATTERNS — Pi Clearance

## Purpose statement

This document is the durable bridge from two reference sources into the clean
pi-clearance product:

- the local `pi-config` clearance proof of concept; and
- the old fork-shaped permission-system scaffold currently being retired.

These sources are **command-pattern, fixture-vocabulary, package-shape, and
tune-report inspiration only**. They are not runtime architecture for
pi-clearance. The product remains a clean configurable Pi clearance built around
parsed command shapes, composable rule packs, approved policy growth, and optional review
fallback. It is not a maintained permission-system fork.

The durable translation rule is: capture reference intent as fixtures and prose, then
implement future behavior through this repo's parsed `BashCommandShape`, policy DSL, rule
packs, fixture harness, replay validation, and user-approved policy growth. Raw
full-command regexes, hand-rolled tokenizers, shell splitters, wildcard permission maps,
permission-session machinery, and POC classifier helper implementations are not runtime
building blocks for this project.

## Captured fixture vocabulary and destinations

Captured command rows normalize to this JSON-compatible fixture vocabulary:

```json
{ "command": "<shell string>", "expected": "fast_path|review|hard_block", "reason": "<short prose>" }
```

Rules for this vocabulary:

- `command` is the exact shell string under evaluation. It may contain real newlines,
  quoted operators, redirects, substitutions, chains, pipelines, semicolon-separated
  blocks, or path tricks because those structures are the behavior under test.
- `expected` is one of exactly three captured labels:
  - `fast_path` — the reference expected deterministic allow-through.
  - `review` — the reference expected human/model review rather than automatic allow.
  - `hard_block` — the reference expected deterministic denial for a catastrophic or
    sealed-floor-like case.
- `reason` is short human prose explaining the structural lesson.
- Fixture JSON is a top-level array and contains no provenance fields, comments, or extra
  keys. Provenance belongs in sibling files, not inside the corpus rows.

Reference-capture destinations:

- `test/fixtures/corpus/pi-config-classifier.json` — verbatim frozen POC classifier corpus
  using the shape above.
- `test/fixtures/corpus/pi-config-classifier.README.md` — provenance and license note for
  the frozen POC corpus.
- `test/fixtures/corpus/fork-derived.json` — curated old-fork command-shape cases using
  the same vocabulary.

Downstream fixture harnesses may map `fast_path` to `allow`, `review` to `review`, and
`hard_block` to `deny`, but this capture layer does not define the final interpreter.

## Source inventory

These paths describe where the lessons came from on the capture machine. They are
provenance pointers, not load-bearing instructions for future agents; the sections below
are self-sufficient even after the local POC tree or fork-shaped files are deleted.

| Source | Local path | Remote | Commit | Provenance / license note | Captured use |
|---|---|---|---|---|---|
| POC classifier corpus | `../pi-config/tests/fixtures/clearance-classifier-policy.json` | `git@github.com:nklisch/pi-config.git` | `ddf3a60641cbbb1e5761865f6bca702b19a5267b` | Owner: nklisch. `../pi-config` has no LICENSE file or package metadata at the captured commit; no license is invented here. This copy is reference material and defers to owner-supplied license text. | Verbatim fixture-vocabulary anchor copied to `test/fixtures/corpus/pi-config-classifier.json`. |
| POC runtime reference | `../pi-config/pi/extensions/clearance.ts` | `git@github.com:nklisch/pi-config.git` | `ddf3a60641cbbb1e5761865f6bca702b19a5267b` | Same no-license/provenance note as the POC corpus. Read-only reference only. | Command-family intent, risky-behavior names, compound-command guard rationale, local-tool approvals, and fast-path caveats. |
| POC tune reference | `../pi-config/bin/clearance-tune` | `git@github.com:nklisch/pi-config.git` | `ddf3a60641cbbb1e5761865f6bca702b19a5267b` | Same no-license/provenance note as the POC corpus. Read-only reference only. | Dry-run report fields, before/after compare shape, Markdown report sections, and fixture-runner ergonomics. |
| POC fast-path tests | `../pi-config/tests/clearance-fastpath.test.mjs` | `git@github.com:nklisch/pi-config.git` | `ddf3a60641cbbb1e5761865f6bca702b19a5267b` | Same no-license/provenance note as the POC corpus. Read-only reference only. | Concrete safe and unsafe command examples used to derive grouped lessons. |
| POC tune skill | `../pi-config/.pi/skills/clearance-tune/SKILL.md` | `git@github.com:nklisch/pi-config.git` | `ddf3a60641cbbb1e5761865f6bca702b19a5267b` | Same no-license/provenance note as the POC corpus. Read-only reference only. | Historical workflow precedent: baseline, inspect misses, show changes, rerun compare, then challenge with adversarial fixtures. Current tune batches are sized to evidence rather than inherently one change. |
| Old fork tests | `test/bash-external-directory.test.ts`, `test/handlers/external-directory-*.test.ts`, `test/detect-permissive-bash-fallback.test.ts`, wider `test/` tree | `git@github.com:nklisch/pi-clearance.git` | `234d1c22c4f959e67f5cb6d2984ce53f17ff0873` plus current working tree during cleanup | Historical mining provenance only; these tests are from the fork-shaped scaffold and do not define the new behavior contract. | Command strings and structural cases curated into `test/fixtures/corpus/fork-derived.json`. |
| Old fork package metadata | `package.json` | `git@github.com:nklisch/pi-clearance.git` | `234d1c22c4f959e67f5cb6d2984ce53f17ff0873` plus current working tree during cleanup | Historical mining provenance only. Fork name/version/description are cleanup inputs, not product identity. | Package-shape facts for the note below: Pi extension entry, ESM type, peer/runtime dependencies, and Node engine. |

Captured POC corpus provenance also lives beside the copied corpus in
`test/fixtures/corpus/pi-config-classifier.README.md`: source path, remote, captured
commit, owner, license status, row count, and row shape.

## Command-pattern lessons

These lessons are intentionally phrased as command families and structural caveats, not
as reusable matching code. Future packs should express them over parsed command-shape
fields and tested DSL matchers.

### `fast_path` candidates

The POC points to these as useful baseline-pack candidates when their parsed shape is
clean and no sealed-floor or review-gate condition is present:

- Read-only shell inspection: directory listing, file viewing, file metadata, counts,
  environment/state inspection, command help/version checks, and simple formatted output.
- Read-only search and stream inspection: grep-like search, JSON/text filters, strict
  print-only `sed -n` line ranges, `sort`/`uniq`/`cut`/`tr` when used as readers rather
  than output writers or shell launchers.
- Read-only Git and GitHub CLI inspection: status, log, diff, show, branch/tag listing,
  worktree listing, config reads, PR/issue/run viewing, checks/status, and read-only
  `gh api` calls that do not request mutating methods or field-submission behavior.
- Bounded system log inspection: `journalctl` used for reading logs, especially when
  piped to a bounded display stage such as `tail`; journal maintenance operations are
  not part of this family.
- `cd repo && safe` and `cd repo; safe` forms when the directory-change prefix is followed
  only by independently safe command blocks.
- Safe `&&`, semicolon, and newline blocks when every top-level segment independently
  qualifies as safe. Operators embedded inside quotes are data, not shell control flow.
- Safe pipelines when every stage is independently safe and the pipeline does not end in
  or hide a shell interpreter.
- Narrow `|| true` and `|| :` fallbacks, including no-space spellings such as `||true`,
  only when the left side is already safe and the fallback merely suppresses a non-zero
  probe exit. Standalone `true` or `:` is not the same lesson.
- Benign stderr redirects such as dropping stderr to `/dev/null` or merging stderr into
  stdout for display. Broad stdout redirects and nonstandard redirect targets belong in
  review.

### `review` candidates

The POC and fork-derived review sets are the richest source of adversarial fixture ideas.
These families should not fast-path merely because the first visible command looks safe:

- Pipe-to-shell forms such as safe-looking output piped into `sh`, `bash`, `zsh`, or
  another shell interpreter.
- Command substitution and process substitution, especially when they hide file reads,
  destructive commands, or credential access inside an otherwise familiar command.
- Heredocs and comment-led multi-line snippets. The POC kept these review-gated rather
  than trying to infer intent from a text block.
- Secret-bearing input or arguments: credential-file input redirects, `.ssh`/cloud/Pi auth
  paths, direct `.env` reads/copies, and secret-looking environment expansion such as
  token, password, private-key, or access-key variables.
- Broad or ambiguous redirects: stdout file writes, whole-command redirection forms,
  unexpected file-descriptor redirects, and redirect targets that only look like benign
  stderr suppression.
- Mutating GitHub API usage: explicit POST/PUT/PATCH/DELETE methods, equivalent method
  spellings through shell quoting, and field/input flags that can switch a nominal API
  call into a mutation.
- Destructive Git behavior: force pushes and plus-refspecs, hard resets, destructive
  clean operations, branch deletion, and worktree removal, including when hidden behind
  global Git options or after a safe prefix.
- `sed` strict-print evasion: write commands, extra programs, in-place or execute-style
  behavior, and quoted option tricks that add a second program after a safe-looking print.
- Reader tools with mutation escapes: output-writing `sort`, multi-output `uniq`,
  destructive or executing `find`, and `journalctl` maintenance/vacuum operations.
- Path and basename spoofing: local-tool lookalikes, suffix tricks, arbitrary absolute
  paths, path traversal, doubled or non-canonical path segments, and approved path
  prefixes followed by traversal to a different executable.
- External-directory and trust-boundary cases from the old fork tests: outside-project
  reads/writes, external `cd` changing the base for a later path, home-expanded SSH paths,
  and most-restrictive-wins precedence examples.
- Unsafe composition: safe command followed by unsafe `&&`, semicolon, or newline segment;
  multiple `||` fallbacks; non-true/colon fallbacks; expansions standing in for fallback
  commands; backgrounding with `&`; stderr-pipe syntax; subshell groups; and brace groups.
- Local scripts and shell wrappers when the deterministic policy cannot inspect their
  behavior from the command shape alone.

### POC `hard_block` rows and sealed-floor nuance

The frozen POC corpus has exactly five `hard_block` rows:

- root recursive delete with an option terminator;
- block-device overwrite;
- filesystem formatting through an `mkfs` frontend;
- root recursive delete hidden inside an otherwise safe-looking `&&` chain; and
- root recursive delete hidden inside a semicolon-separated block.

Those five rows describe the POC corpus, not this project's complete sealed floor. The
foundation docs remain authoritative: `SPEC.md`, `RULE_PACKS.md`, and `PRINCIPLES.md`
define a broader downstream sealed-floor design space that includes catastrophic
filesystem/disk/system behavior, secret exposure, privilege escalation, remote execution,
parser-defeating forms, and shutdown/reboot. Capturing only five POC `hard_block` labels
must not downgrade other foundation-defined floor candidates to ordinary review.

### Risky-behavior catalog

The POC named risky behaviors so the reviewer could see why a command deserved scrutiny.
For this project, the names are useful catalog terms for review-gate packs and fixtures;
the POC's detection code is not reusable runtime logic.

- **force-push** — remote history overwrite through force flags or plus-refspecs.
- **branch-delete** — local branch deletion, especially destructive deletion of work that
  may lack a remote or durable reflog.
- **worktree-remove** — removing a linked working tree directory.
- **hard-reset** — discarding working tree and index changes.
- **git-clean** — deleting untracked or ignored files/directories.
- **recursive-delete** — recursive filesystem deletion outside the catastrophic root case.
- **privilege-escalation** — commands that elevate privileges or request administrator
  execution.
- **broad-chmod** — world-readable/world-writable permission broadening such as mode 777.
- **fork-bomb** — shell forms that exhaust process resources.
- **disk-destructive** — direct disk overwrite or filesystem formatting operations.
- **system-shutdown** — shutdown, reboot, halt, poweroff, or equivalent system-stop forms.
- **remote-shell** — remote content fetched and piped into a shell for immediate execution.

The POC often treated these as `review` behaviors, not automatic `hard_block` outcomes.
Only its catastrophic subset became `hard_block`. That matches `RULE_PACKS.md`: the sealed
floor is intentionally narrow and high-confidence, while broader risky behavior belongs in
review-gate packs unless downstream pack/core design promotes a case into the sealed floor
with evidence.

## Tune report target shape

The POC tune workflow is valuable because it dry-runs command history and fixtures
without executing commands, then makes before/after policy changes visible. Downstream
tune work can rename fields or add provenance/rule-id columns, but should preserve this
shape and the asymmetry principle from `PRINCIPLES.md` §8: allow expansions such as
`review->fast_path` transitions must be visually obvious in compare output.

Target JSON report shape:

```text
{
  generatedAt,
  repoRoot,
  sourcePath,
  summary: {
    totalCalls,
    totalUnique,
    fastPathCalls,
    fastPathUnique,
    reviewCalls,
    reviewUnique,
    hardBlockCalls,
    hardBlockUnique
  },
  topReviewedExecutables,
  topFastPathExecutables,
  topReviewedCommands,
  topHardBlockedCommands,
  perCommand: [
    { command, count, executable, status, reason, behaviors? }
  ],
  compare?: {
    changedUnique,
    changedCalls,
    transitions,
    beforeSummary,
    afterSummary
  }
}
```

Additional shape notes:

- `perCommand.status` uses the captured labels: `fast_path`, `review`, or `hard_block`.
- `transitions` is a sorted before/after status list such as `review->fast_path` with a
  count. The important lesson is not the exact representation; it is that newly allowed
  commands stand out during review.
- Markdown reports should include, in order: title, generated timestamp, `## Summary`
  with counts and percentages, optional `## Compare` with changed counts and transition
  lines, `## Top reviewed executables`, `## Top reviewed commands` with reasons, and
  `## Top hard-blocked commands`.
- The agent workflow around the report should baseline current behavior, inspect misses by
  family, make evidence-sized bounded changes, rerun with compare, run fixtures, and then
  add curated adversarial cases. Adversarial agents or reviewers find clever breaks; they
  do not decide which ordinary workflows should become policy.

## Package-metadata reference note

The old fork `package.json` is mined for package-shape facts only. The durable product
target identity is Pi Clearance / `pi-clearance` as a clean pre-1.0 Pi extension; `package-spine` resets the
fork-shaped `name`, `version`, and `description` instead of preserving them as product
identity.

Package-shape facts to carry forward:

- Pi extension entry convention: `pi.extensions: ["./src/index.ts"]`.
- ESM package mode: `"type": "module"`.
- Pi host API as peer dependency: `@earendil-works/pi-coding-agent` stays a peer, never a
  bundled runtime dependency.
- Bash parser grammar source: `tree-sitter-bash`; the active product target routes runtime
  parsing through the Rust native clearance core rather than a JavaScript/WASM parser
  dependency shape.
- Node engine: `node >=22.18`, matching the Pi host runtime expectation. Pi loads the package's TypeScript extension entrypoint directly.

Cleanup inputs only:

- The fork-shaped package `name`, `version`, and `description` are not durable identity.
  `package-spine` owns the reset to clean pre-1.0 metadata for this product.
- The old fork exports, files list, schemas, config examples, permission-system keywords,
  and extra permission-manager package surface are not behavior contracts. Future package
  metadata should be derived from `docs/VISION.md`, `docs/SPEC.md`, and the clean module
  spine.

## Do-not-port architecture bullets

- Do not port `AUTO_PERMITTED` regexes, `roughTokenize`, `splitTopLevel`, or
  `isSimpleCommand`/`isFastPathEligible*` as runtime safety mechanisms.
- Do not treat `peeragent`, `agent-comms`, or `.work/bin/work-view` POC approvals as
  universal shipped defaults.
- Do not treat old fork tests or flat `allow|ask|deny` / wildcard matcher maps as the new
  behavior contract.
- Do not bring forward `PermissionManager`, `yoloMode`, session approval, subagent
  forwarding, or wildcard permission architecture.
- Do not redefine the sealed floor from the POC label distribution. The POC has only five
  `hard_block` rows, but foundation docs keep secret exposure, privilege escalation,
  remote execution, parser-defeating forms, and shutdown/reboot in sealed-floor scope
  unless downstream pack/core design narrows a specific case with evidence.
- Do not invalidate corpus JSON with comments or embedded provenance.

The intended flow is: translate useful examples into parsed-shape fixtures and pack tests;
implement policy through this repo's analyzers, DSL matchers, sealed-floor validation,
review-gate packs, replay reports, and user-approved overlays.

## Category coverage check

Across `test/fixtures/corpus/pi-config-classifier.json` and the curated
`test/fixtures/corpus/fork-derived.json`, the captured examples represent the reference
categories the downstream fixture harness must preserve:

- safe read chains and `&&`/`;`/newline blocks of independently safe commands;
- `cd repo && safe` directory-change chains;
- narrow `|| true` / `|| :` fallbacks, including the no-space `||true` form;
- safe read-only pipelines including `| sed -n` strict print and `| tail`;
- pipe-to-shell forms such as `| sh` and `| bash`;
- command substitution `$(...)` and process substitution `<(...)`;
- heredocs;
- stdout redirects `>` and broad redirects, plus benign stderr redirects such as
  `2>/dev/null` and `2>&1`;
- secret path input redirects such as `< ~/.ssh/id_rsa`, `< ~/.aws/credentials`, and
  `< $HOME/.pi/agent/auth.json`;
- secret-looking environment expansion such as `$GH_TOKEN` and
  `${AWS_SECRET_ACCESS_KEY}`;
- mutating GitHub API forms such as `gh api ... -X POST`, `--method DELETE`, and field
  flags that switch a request into mutation;
- destructive Git forms such as plus-refspec force push, `reset --hard`, `clean -ffdx`,
  and `branch -D`;
- `sed` strict-print fast path versus `w`/`-e` extra-program evasion;
- `sort`, `uniq`, `find`, and `journalctl` tricks such as `-o`, `-delete`, `-exec`, and
  `--vacuum-time`;
- path spoofing and lookalikes such as `peeragent.bak`, `work-view.evil`, `..` traversal,
  and non-canonical approved paths; and
- catastrophic root/disk/system forms such as `rm -rf -- /`, `dd of=/dev/sda`, and
  `mkfs -t ext4 /dev/sda`, including when hidden inside `&&`, semicolon, or newline
  chains.

This coverage assertion is a reference-capture check, not the final product contract.
`capture-verification` enforces that the two corpus files keep these categories
represented, while downstream pack/core design remains responsible for deciding which
categories become allow, review, or deny under the clean interpreter.
