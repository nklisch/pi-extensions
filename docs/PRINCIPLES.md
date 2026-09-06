# Engineering Principles

Project-owned engineering values for the pi-extensions monorepo. Change these
rules deliberately, not incidentally.

## Publishing safety

Nothing reaches npm unless it is deliberately shaped for publishing: scoped
`@nklisch`, non-private, complete metadata, inspected tarball contents, and
trusted-publisher provenance from the release workflow only.

### Why

This repository exists to be the single publishing home for all of the
author's Pi extensions. A mis-scoped, accidental, or tampered publish is the
worst failure mode this repo can have — worse than any bug in any package.

### Implications

- Package validation (`scripts/validate-packages.mjs`) is policy, not lint:
  new packages must satisfy it before they can exist in the tree.
- Tarball inspection (`scripts/check-packs.mjs`) runs on every check; what
  ships is reviewed as a first-class artifact, not an afterthought.
- Platform-specific packages are derived from their root manifest, versioned
  exactly with it, built for every declared target, and published before any
  root package that references them.
- Publishing is a manual workflow dispatch from `main`, never a side effect
  of merging or committing.

### Boundaries

Does not forbid experimentation: packages stay unversioned (`0.1.0`) and
unpublished as long as needed. Safety governs the publish path, not the pace
of development.

## Compatibility posture for published surfaces

Published packages have real external consumers — the author's own machines
and any downstream installs. Their public surfaces (extension entrypoints,
registered tools/commands, config file locations, wire protocols) change
deliberately and are communicated through versioning. Everything unpublished
— internal APIs, work-in-progress packages, project-owned schemas — changes
in place with no shims and no v1/v2 parallel versions.

### Why

The repo mixes mature published packages (pi-mcp-adapter, pi-subagents,
pi-plugins) with fresh ones. Treating internal surfaces as compatibility
burdens would freeze design; treating published surfaces as freely mutable
would break real installations.

### Implications

- Renames and breaking changes to published packages are planned, versioned
  events (e.g. pi-auto-approve → pi-clearance before first publish).
- User-facing config paths and data formats of published packages are real
  data: migrations are planned by the agent but approved and executed by the
  user.

### Boundaries

Packages that have never been published have no external consumers regardless
of how polished they look. The default for anything project-owned is no
compatibility work.

## Contract truth has one owner

Code-defined structures have one machine-readable authority. Documents explain
semantics, invariants, boundaries, and rationale rather than maintaining a
second copy of internal schemas or interfaces. Public protocols may need a
standalone or generated specification, but each structural definition still
has one authoritative source.

### Why

Independent copies drift and make contributors guess which one is binding.
Choose authority at the contract boundary and derive dependent representations
where practical.

## Leave touched work simpler

Remove code, tests, abstractions, checks, and compatibility paths that the
current work makes unnecessary. Preserve meaningful behavior, guarantees,
validation, compatibility, safety, and measured performance constraints unless
the user explicitly authorizes a change. Avoid obvious plausible performance
regressions.

### Why

Every retained mechanism has a maintenance cost. Simplification earns its place
by lowering that cost without weakening the product; it does not authorize
adjacent redesigns or removal of protections that still serve a real need.

## Tests earn their upkeep

Tests are kept because they catch real regressions at contract and risk
boundaries — parsers, policy engines, pack contents, protocol adapters — not
because coverage looks good. A test that breaks on every refactor without
ever catching a bug gets deleted, not nursed.

### Why

Large test suites make low-value tests a tax on every change and teach
contributors to ignore failures.

### Implications

- Prefer contract-level and regression-driven tests; be suspicious of tests
  that mirror implementation structure.
- Smoke tests are acceptable for thin extension registration surfaces (the
  bun-tested packages), where the real risk is "tool not registered," not
  logic.
- Supply-chain-sensitive behavior (pack contents, bundled dependencies,
  provenance) warrants exact pinning tests even when they are brittle by
  nature — that brittleness is the alarm working.

### Boundaries

Brittle-by-design pinning tests (registry bytes, packed surfaces) are exempt
from the "breaks on every refactor" deletion rule; they are supposed to
demand attention when bytes change.

## Fail-closed guards must defend against a real threat

A guard that refuses to operate — refuses to start, refuses to activate,
refuses to read, refuses to install — must justify the refusal with a concrete
threat model and a protection the guard actually provides. "Conservative" is
not a substitute for a threat model. A fail-closed stance that breaks
legitimate real-world input without protecting against a real attack is a
bug wearing a security costume.

### Why

Filesystem identity heuristics, unfamiliar platform values, and missing optional
artifacts do not by themselves prove an attack or an unusable capability. A
refusal based on those guesses can disable legitimate installations without
protecting user data. Measure the required behavior or keep a degraded path;
reserve refusal for a concrete threat or an actual capability gap.

### Implications

- **Name the threat before writing the guard.** A comment that says "intentionally
  conservative" or "unknown mounts are a capability failure" without naming
  the attack and how the guard stops it is the smell. If you cannot state the
  threat in one sentence, the guard is ceremony.
- **The threat model is this product's, not a server's.** These extensions run
  on the user's own machine, against the user's own filesystem, registry, and
  keyring. SSRF defenses, filesystem magic-number allowlists, and address-class
  blocking defend against *untrusted input driving the host's network and disk*,
  which is a real threat for servers and a much narrower one here. Scale the
  guard to the actual attack surface.
- **Prefer a degraded path over a refusal.** If the capability probe fails, the
  question is "what does the user lose?" — not "how do we refuse?". Unknown
  filesystem → log and continue with SQLite locking as-is. Missing native
  prebuild → fall back to a slower path or clearly mark the surface as
  unavailable, do not brick the extension. No binary on this platform → degrade
  the feature, do not refuse to arm.
- **Provide an override, or do not ship the guard.** A fail-closed guard with
  no env, config, or programmable escape hatch will eventually trap a real
  user on a legitimate input. Build the override at the same time as the guard.
- **Do not write a regression test that accepts either failure or success.**
  That test is a confession that the behavior is underspecified. Pin the
  behavior per platform or pin the override semantics.
- **After two rounds of the same breakage, remove the category, not the
  instance.** If a class of guard has bitten twice, the third conservative
  variant of it will bite too. Either drop the category or replace it with a
  behavior probe that measures what it claims to enforce.

### Boundaries

This principle governs *operational* fail-closed — startup, activation,
filesystem and platform capability, registry and network acquisition, secret
store availability. It does **not** govern product security policy.
pi-clearance denying an unknown bash command is the product's whole purpose;
policy fail-closed is correct by construction. The test is whether the
refusal protects against a real threat (policy denial does; a missing platform
prebuild does not).

Genuine capability gaps — "this platform has no SQLite," "this filesystem
doesn't support POSIX modes" — are still allowed to throw. The principle is
about guards whose "capability" is a guess or an allowlist, not a fact.

## Extension failures stay inside the extension boundary

An extension may fail a tool call or report degraded capability, but it must not
terminate Pi through an uncaught callback exception or unhandled rejection.
Recovery and observability are both part of the contract.

### Why

Pi already contains errors from registered tools, commands, and awaited
lifecycle handlers. Extension-owned work can outlive those host boundaries:
timers, child-process listeners, event-bus subscribers, UI component callbacks,
and deliberately detached promises run later and can otherwise reach Node's
process-level error path. Session replacement and reload also deliberately make
old Pi and command-context objects throw when reused.

### Implications

- Keep direct tool failures as thrown tool errors when Pi owns the awaited call.
  That is how the agent receives an `isError` result. Do not hide them behind a
  success-shaped value.
- Every extension-owned detached boundary catches synchronous throws and promise
  rejections at its outermost callback. One failing cleanup or notification does
  not prevent the remaining cleanup or the primary operation from settling.
- Detached work retains plain immutable operation inputs, not a live
  `ExtensionContext` or command context. Any session reporting handle is
  lifecycle-owned and revocable. Shutdown revokes it before cleanup. Late
  callbacks may update plain state but cannot use stale session-bound APIs.
- Report through the strongest channel still available: a structured tool
  failure, job output/status, operator health state, user notification, or a
  bounded diagnostic log. Containment must not silently turn failure into
  success.
- Tests drive the boundary itself: rejecting promises, throwing timer and
  process callbacks, stale contexts, and failing cleanup/reporting sinks.

### Boundaries

This principle does not require catching programmer defects in pure internal
functions at every call site. Containment belongs where control leaves the
extension or becomes detached, so failures remain debuggable without redundant
catch layers throughout domain code.
