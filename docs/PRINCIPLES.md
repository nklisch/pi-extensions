# Engineering Principles

Project-owned engineering values for the pi-extensions monorepo. Confirmed
during Workbench setup; change them deliberately, not drift-wise.

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
- Mid-implementation packages (currently pi-plugins) may break their own
  internals freely until published.

### Boundaries

Packages that have never been published have no external consumers regardless
of how polished they look. The default for anything project-owned is no
compatibility work.

## Tests earn their upkeep

Tests are kept because they catch real regressions at contract and risk
boundaries — parsers, policy engines, pack contents, protocol adapters — not
because coverage looks good. A test that breaks on every refactor without
ever catching a bug gets deleted, not nursed.

### Why

The repo carries very large suites (pi-clearance ~2,700 tests, pi-plugins
~1,700). At that scale, low-value tests are a tax on every change and teach
contributors (human and agent) to ignore failures.

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
bug wearing a security costume. Three rounds of the same anti-pattern in
pi-plugins cost real uptime before this rule was named.

### Why

The pi-plugins filesystem gate failed closed three times in a row, each time
on a different common platform, each time after a "conservative" fix to the
previous round:

1. **v0.2.3** — treated `st_dev` as stable file identity. btrfs and overlayfs
   assign anonymous device numbers per mount, so every reboot changed device
   while files and inodes were unchanged. The host hard-failed startup.
2. **v0.2.4** — the entire sqlite file-identity machinery (`.identity`
   markers, `.initializing` claims, root identity markers, device/inode
   validation, hard-link handle aliases, per-transaction root re-verification)
   was ripped out. The CHANGELOG's own verdict: *"the guards false-positive-
   broke normal operation after every routine reboot on btrfs/overlayfs…
   while never catching a real replacement."*
3. **v0.3.3 (issue #2)** — a fresh "conservative" magic-number `f_type`
   allowlist failed closed on every real macOS APFS volume because Node returns
   a vestigial `0x1a` on Darwin regardless of filesystem. The package refused
   to start on macOS.

The shared shape: each guard read as thorough, had a plausible-sounding
comment, and shipped over real user-visible breakage because reviewers could
not tell ceremonial security from real security. The category is the enemy,
not any one guard.

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
  behavior per platform or pin the override semantics. (The capability gate
  regression was hidden for exactly this reason.)
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
