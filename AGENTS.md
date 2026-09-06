# Pi Extensions Monorepo

All publishable workspaces live under `packages/pi-*` and must publish as `@nklisch/pi-*`. Use `npm run create:extension -- <name> [description]` for new packages rather than hand-copying an existing package.

Run `npm run check` after changing package source, metadata, tests, build configuration, or publishing infrastructure. Keep packages independently versioned and do not publish the private root workspace.

Fail-closed guards must defend against a real threat (see
`docs/PRINCIPLES.md`). A guard that refuses to start, activate, read, or
install on legitimate real-world input — unknown filesystem, missing
platform prebuild, unfamiliar magic number, no-SHA-512 packument,
revoked keyring, private-registry hostname — is a bug wearing a security
costume unless it names the threat it stops and ships an override or a
degraded path. Do not add a "conservative" allowlist, magic-number table,
or platform allowlist/denylist without (a) a one-sentence threat model
in a comment and (b) an env or config override. If a class of guard has
broken twice already, remove the category instead of writing the third
variant.

Inter-package dependency ranges are major-only (`^0`, `^2`) — never exact
pins and never patch-floor carets (`^0.1.18` on a 0.x package means
`>=0.1.18 <0.2.0`, which can strand consumers on an old minor line).
Exceptions: pi-plugins' sibling pins on pi-mcp-adapter and pi-subagents stay
exact so the host resolves its maintained adapter and bundled subagent runtime.
Update consumer pins whenever those sibling versions change.
pi-enhanced also pins pi-mcp-adapter exactly because its bundled registry must
identify this maintained fork rather than admit an upstream `^2` release.

<!-- workbench:start -->
## Workbench

This repository is Workbench-owned. For stateful Workbench work, read
`.work/CONVENTIONS.md`, relevant foundation documents, and the selected skill
before acting. Follow that skill's required references. Compare
`workbench_version` with the loaded plugin; recommend setup reconciliation on a
mismatch, but continue unless an actual incompatibility prevents the work.
Never run setup without explicit user direction. Keep unrelated requests
outside Workbench.

Use `work` to own a continuous outcome, drawing on `design` for consequential
choices and `deliver` for ready implementation without restarting the workflow.
Reuse unchanged context. Use `ideate` for valuable early exploration, `scan` for
opportunities without remediation, `park` for selected out-of-scope findings,
and `release` only for a requested versioned summary.

The user's request and effective autonomy posture define the authorized
boundary. Ask about consequential requirements; do not invent requirements,
expand scope, or treat repository aspirations as current work. Use features as
the normal delivery unit, epics for multiple feature outcomes, and stories for
narrow slices. Keep independent items parallel and add `blocked_by` only for a
real sequencing dependency.

Before any design or review, including a loose request, apply the current
`## Overbuilding calibration` from `.work/CONVENTIONS.md`. Loose work gets the
lens without other Workbench mechanics. Pass it to delegated roles rather than
assuming fresh context inherited it.

`.work/` is the operational record; foundation documents describe durable
project truth, including the engineering shape contributors need to build and
operate the repository coherently. Only write durable artifacts named by the
active workflow. Questions, proposals, progress, recommendations, and
completion reports belong in chat. Keep human-facing documents clean and
self-contained: lead with
business or real-world meaning, define important non-obvious domain concepts
before using them, and omit agent history or review narration.

Apply configured execution, review, simplification, and commit postures.
Align optional design review once per run. Choose adaptive implementation review
boundaries, including shared reviews across features or deliveries. Verify each
unit promptly and keep deferred review visible until the owning items can close.
Scale effort to the work. Quick implementation and focused review often benefit
from the current context; use another when it adds enough value or is requested.
Test meaningful behavior at stable
interfaces, verify the full requested boundary, reconcile affected foundation
truth and indexes, and close completed work. Reviewers propose; the outcome
owner verifies and adjudicates. Park valuable adjacent findings instead of
silently adding them to scope.
<!-- workbench:end -->
