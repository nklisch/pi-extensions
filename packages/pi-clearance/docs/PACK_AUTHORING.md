# Pack authoring

Pack authoring is the advanced path for teaching Pi Clearance new deterministic policy.
Use it when repeated history shows a command family that should be handled without runtime
model review.

Use this order:

1. **Enable an existing shipped or package-contributed pack** if one already matches the
   workflow. Package installation only makes packs available; enablement still goes through
   user-owned config and approval.
2. **Write a data pack** when the policy can be expressed with the matcher DSL. Normal file
   editing can create a global or project raw pack definition in `packs`, but broadening policy
   still needs schema validation, sealed-floor checks, replay evidence, and approval.
3. **Propose a new DSL matcher** when a repeated need is general but the current DSL cannot
   express it inspectably. Reusable behavior belongs in data-shaped matcher vocabulary before it
   becomes executable code.
4. **Record a DSL gap for core matcher work** when the needed policy is genuinely reusable but
   cannot yet be represented safely as data. Trusted TypeScript rule modules are cut and are not
   an authoring target.

## Authoring workflow

1. Start from real repeated history, not a one-off annoyance.
2. Check the shipped and package-contributed pack registry first.
3. If no existing pack fits, draft the narrowest data pack that explains the command family.
4. Run schema/provenance validation, sealed-floor overlap validation, replay, and adversarial
   near-miss checks. Treat the structured validation fields as authoritative: markdown is a
   concise rendering, while `details.proposal`, `details.delta`, adversarial reports, and
   validation checks carry the evidence to inspect.
5. Show the exact raw pack diff or `packEnablement` patch, including warnings and required
   acknowledgments.
6. Write only user-owned config after explicit approval.
7. Re-run replay/fixtures and keep any follow-up as normal substrate work.

Keep this page as the canonical reference. Thin skills, tune cards, and command help should
link here instead of copying the full authoring rules.

## Data packs

Data packs are JSON-compatible objects validated at load time. They are preferred because
they are inspectable, replayable, and overlap-checkable against the sealed floor. User-authored
raw packs live in the global or project config `packs` array and become active by presence unless
that config explicitly lists their id in `disabledConfigPacks`.

```json
{
  "version": 1,
  "id": "example.project-docs",
  "rules": [
    {
      "id": "allow-docs-listing",
      "effect": "allow",
      "match": {
        "all": [
          { "tool": "bash" },
          { "program": "find" },
          { "argAt": { "index": 1, "equals": "docs" } },
          { "noSubstitution": true },
          { "noStdoutRedirect": true }
        ]
      },
      "reason": "List project docs without mutation",
      "provenance": { "source": "user-project" }
    }
  ]
}
```

Rules have three effects:

- `allow` — the command can run without review when the matcher proves the shape is safe.
- `review` — the command should be routed to human/model review.
- `deny` — the command should be blocked.

Active precedence is fixed: `deny > review > allow`.

The structural DSL also provides `flagMatches` (`names`, `prefixes`, and
bundled short `shortChars`), `envAssignmentNameIn` (`names`, `prefixes`, and
case-insensitive prefixes), and `argMatches`:

```json
{ "argMatches": { "index": 0, "pattern": "[A-Za-z][A-Za-z0-9:_-]*" } }
```

`argMatches` anchors the supplied Unicode regular expression to the complete
positional argument at the zero-based `index`; a missing argument is false.
`anyArgMatches` anchors a supplied Unicode regular expression to complete positional
arguments and succeeds when any positional argument matches. It is useful for narrow
value-shape guards such as `of=/dev/...`; flags and their values are not positional
arguments. `argCount` and `envAssignmentCount` accept optional non-negative `min`/`max`
bounds and quantify every command stage. `flagAllowlist` accepts `names` and
bundled-short `shortChars`; an empty object matches only stages with no flags,
while a non-empty allowlist requires at least one permitted flag.
`flagValueIn` requires non-empty `names` and `values` and only accepts inline
flag values, so space-separated values fail closed. These predicates inspect
all command stages; use the environment predicate for review gates rather than
embedding a runtime denylist in code. Direct read-only shipped allows derive
their flag safety guards from the effect registry, so authored allow rules
should keep those same hazards out of any read-only family.

The `redirect` matcher optionally accepts `targetKind` (`file`, `fd`, `heredoc`,
or `herestring`) so review rules can distinguish a file write from a file-descriptor
duplication. File redirects remain the conservative default for output-write gates.

### Leading-option diagnostics

The parse layer may project supported options that occur before a program's real
subcommand. Successful projections emit the informational
`bash:leading-options-stripped` diagnostic with the consumed option span; info
diagnostics do not block an otherwise matching allow. An unsupported or
ambiguous leading option emits the warning
`bash:leading-option-unmodeled` and leaves the stage untouched. Warning-bearing
shapes cannot reach allow rules, so packs should not compensate for an unmodeled
option with flag or argument arithmetic. A review pack may match the named
diagnostic directly when it needs specific provenance.

Allow rules must be overlap-decidable against the sealed floor. Unknown overlap rejects the
write instead of creating a potentially unsafe allow.

### Composition matchers

`composition` evaluates one stage matcher independently against every command
stage. Its `operators` list accepts only `and` and `seq`; background blocks are
rejected unless `allowBackground` is explicitly true. Use `minStages` to keep a
composition rule limited to multi-stage commands (the baseline uses `2`).

`orFallback` is a deliberately narrow extension: entries may only be `"true"`
or `":"`, and an `or` is accepted only immediately before the final block. That
block must contain exactly one resolvable, bare no-op command with no arguments,
flags, environment assignments, substitutions, redirects, pipeline, or
background execution. Other `||` forms remain review-gated.

A composition allow's stage matcher should be a union of concrete program-
anchored family clauses. Load-time overlap reduction uses that union as a
necessary condition: an unanchored alternative reduces to `unknown` and rejects
the allow, while a family containing a sealed-floor program is rejected as an
overlap. This is intentionally conservative; keep family clauses identical to
the standalone allow rules they reuse.

`stageSome` on the sealed-floor side reduces to an existential necessary-constraint
set for program, arg0, and argAt witnesses. Universal allow constraints can prove
disjointness only when their field values are disjoint from those existential values.
An inner with no concrete anchor, and every allow-side `stageSome`, remains `unknown`;
unknown overlap is rejected rather than treated as safe.

### Pack metadata

A data pack may carry an optional `metadata` object for registry listing, filtering, and provenance display:

```json
{
  "version": 1,
  "id": "example.project-docs",
  "metadata": {
    "title": "Project docs listing",
    "description": "Read-only docs listing rules.",
    "docs": [{ "label": "Pack authoring", "href": "docs/PACK_AUTHORING.md" }],
    "tags": ["docs", "read"],
    "warnings": [{ "level": "info", "message": "Read-only only." }],
    "examples": [
      {
        "outcome": "allow",
        "shape": "find docs -maxdepth 1 -type f",
        "note": "Project docs listing"
      },
      {
        "outcome": "review",
        "shape": "find ~/Downloads -type f",
        "note": "Outside the project"
      }
    ]
  },
  "rules": []
}
```

`metadata` fields are `title`, `description`, `docs` (`{ label, href }` links), `tags`, `warnings` (`{ level, message }` with `level` of `info`, `warning`, or `danger`), and `examples`. Every field is optional. Metadata is inert: it never affects decisions, precedence, matcher evaluation, or sealed-floor overlap, and `decide` never reads it. Unknown metadata fields fail validation. Omit `metadata` entirely when a pack needs no display data; the registry derives readable defaults from the pack id and source.

`metadata.examples` is an array of representative command or tool-call shapes for the Policy dossiers explorer. Each entry has:

| Field | Values | Notes |
|---|---|---|
| `outcome` | `allow`, `review`, or `deny` | The marker the dossier displays (`✓`, `?`, or `✗`). |
| `shape` | non-empty string | A short recognizable command/tool-call shape, not a full fixture corpus. |
| `note` | string | Optional explanatory note. |

Examples are display data, not replay evidence. They help a person recognize what a pack is about;
they are not executed, not replayed, and not accepted as proof that a policy change is safe. Replay
results, adversarial cases, sealed-floor validation, and structured validation fields remain the
authoritative evidence for enabling or writing policy.

Package source details (package name, version, install path) belong to registry entries, not the pack `metadata` object.

## Path scope

Constructive file operations should gate on path-scope facts. A good allow rule
for commands such as `mkdir`, `touch`, or generated temp-file workflows proves that all
relevant path arguments are inside the configured project or temp scopes and that no dynamic
shell feature hides the actual path.

Path-scope predicates consume inspectable path facts attached to bash shapes
(`BashCommandShape.pathFacts`) rather than re-deriving containment. Each fact records its
winning scope, every matched scope, decoded literal, lexically resolved absolute path, usage,
access, and — when the operand could not be reduced to a single static literal — an explicit
`unknownReason`. Predicates evaluate these facts as data; they do not call the filesystem,
expand globs, or follow symlinks, and every fact carries `normalization: "lexical"` so a
predicate never implies symlink protection.

Project and temp scopes come from the project overlay's `projectScope` field (see
[CONFIGURATION.md](CONFIGURATION.md)). The relevant fields are:

- `roots` — project roots, always including `cwd`;
- `writableDirectories` — project directories constructive writes may target, always
  including `cwd`, and each entry must sit inside a configured root;
- `tempDirectories` — temp directories, always including `os.tmpdir()`;
- `deniedDirectories` — sensitive paths that receive `denied` path facts and must never
  satisfy constructive allow rules;
- `unknownPathBehavior` — `review` or `deny`; there is no `allow` value, so unknown or
  dynamic paths must never satisfy a constructive allow rule. Current shipped packs route
  these fail-closed cases to review unless an explicit deny rule consumes them.

The full scope set a predicate reasons about:

- `writable-project` — a project directory constructive writes may target;
- `project` — a non-writable project root;
- `temp` — a configured (or OS) temp directory;
- `denied` — a sensitive path classification; precedence wins over every concrete scope,
  and project-local allows must reject it;
- `home` — outside the project but under the user's home;
- `outside` — outside all configured scopes;
- `system` — a high-risk platform root such as `/etc`, `/usr`, `/bin`, or `/var`;
- `unknown` — a dynamic, glob, brace, `~user`, unsupported-literal, or unresolved
  cwd-prefix operand; never satisfies an allow.

Project-local allow rules must reject `unknown`, `home`, `outside`, `system`, and `denied`
facts. Only `writable-project`, `project`, and `temp` facts can satisfy a constructive allow,
and only when every path-bearing position the command family touches is covered by a present,
in-scope fact — an unextracted or absent path operand never makes an allow pass on its own.
This reject-unless-contracted default holds unless a later explicit matcher/config contract
widens it for a named scope.

### Path-scope matcher predicates

The DSL exposes three path-scope predicates over `BashCommandShape.pathFacts`:

- `pathScopesAllIn` — every selected fact's winning `scope` is in `scopes`. Use for
  project-local constructive allows.
- `pathScopesNoneIn` — no selected fact's winning `scope` is in `scopes`. Use for review/deny
  rules that gate on unsafe scopes (e.g. none of `outside`, `system`, `denied`, `unknown`).
- `pathScopesSomeIn` — at least one selected fact's winning `scope` is in `scopes`. Use for
  diagnostic/review rules that flag when any fact is `unknown`.

Each predicate compares a fact's **winning** `scope` (`matchedScopes[0]`), not every entry in
`matchedScopes`, so a project under `$HOME` still satisfies a `writable-project` / `project`
allow even though `home` also matched. The whole fact envelope participates by default —
cwd-prefix,
argument, flag-value, redirect-target, and implicit-temp facts — so an allow cannot silently
ignore an unsafe cwd prefix, read reference, or redirect target. Use `usages` to select a fact
usage when the rule separately screens the other classes. `allowExactPaths` accepts normalized
absolute paths such as `/dev/null` regardless of scope; `forbidPathSegments` is a hard exact
segment veto (for example `.git`). Selected usages also determine `requireFacts` coverage. All
new fields remain fail-closed when facts are absent or selected coverage is empty.

The recommended constructive allow pairs the structural safety sentinels with
`pathScopesAllIn` using `requireFacts: "per-command-stage"` and a `programs` coverage guard:

```json
{
  "id": "allow-touch-project-temp",
  "effect": "allow",
  "match": {
    "all": [
      { "program": "touch" },
      { "noSubstitution": true },
      { "noStdoutRedirect": true },
      {
        "pathScopesAllIn": {
          "scopes": ["writable-project", "project", "temp"],
          "programs": ["touch"],
          "requireFacts": "per-command-stage"
        }
      }
    ]
  },
  "reason": "touch within configured project/temp path scope",
  "provenance": { "source": "user-project" }
}
```

`requireFacts: "per-command-stage"` requires every command stage to contribute at least one
non-cwd-prefix path fact whose program is listed in `programs`, and every selected fact's
winning scope to be in `scopes`. This is the coverage guard constructive baseline allows should
use: a missing or unextracted operand cannot satisfy the allow. In JSON packs, `programs` is
accepted only with `requireFacts: "per-command-stage"`; otherwise the program list would be an
inert filter. `requireFacts: "one-or-more"` (the default for `all-in` / `some-in`) only
requires at least one selected fact, and `none-in` has no default requirement.

The predicates are conservative and total: a missing `pathFacts` envelope, zero selected
facts when facts are required, any `scope: "unknown"` fact, any `home` / `outside` / `system`
/ `denied` fact, an unresolved cwd prefix, an unsafe redirect target, or a stage whose program
is not covered makes a project-local allow return `false`. For `none-in` without a
`requireFacts` setting, an empty fact envelope satisfies the negative predicate; use
`one-or-more` or `per-command-stage` when absence of facts should fail closed. Effect precedence is unaffected —
`deny > review > allow` — so a `review` rule for `mkdir -m` and a sealed-floor `deny` for
`sudo` still win over a matching path-scoped allow.

The runtime enrichment seam supplies cwd and project scope only; `homeDirectory` plumbing is
tracked separately. As a result a runtime `~/...` operand stays `scope: "unknown"` and fails
closed rather than resolving to `home` — this is safe current behavior, not a historical aside,
and it causes extra review, never an unsafe allow. Supplying `homeDirectory` at the runtime
seam is the follow-up that lets `~/...` classify as `home`.

## Compound shell matchers

Compound shell matchers consume projected compound bash stages and enriched path/effect facts.
They are conservative, data-only, and total: non-bash shapes, unsupported compound diagnostics,
missing path facts, nested unsupported forms, and unmodeled bodies return `false` for allow-side
predicates.

The JSON matcher vocabulary for compound packs is:

- `compoundForm`: one of `"for"`, `"brace-group"`, or `"if"`; matches only when every top-level
  stage is that projected compound form.
- `bodyStagesAllReadOnly: true`: every modeled body command stage is classified read-only by the
  effect registry.
- `iteratorScopesAllIn: { "scopes": [...] }`: every loop-variable provenance fact and iterator
  source entry has a winning scope in the listed scopes.
- `bodyStagesAllScopeIn: { "scopes": [...] }`: every trusted body-stage file-input fact is present
  and in the listed scopes.
- `noBodySubstitution: true`: modeled body command stages contain no command, process, or
  arithmetic substitutions.
- `noBodyShellWrap: true`: modeled body command stages are not shell wrappers such as `sh`,
  `bash`, or `eval`.
- `noBodyRedirectTo: true`: modeled body commands and brace groups do not redirect stdout,
  stderr, combined output, or file descriptors to files.
- `diagnosticCode: "..."`: matches a specific analyzer diagnostic, useful for review/deny rules
  that should supply provenance before the generic diagnostic review fallback.

The only shipped compound allow shape is the canonical proof bundle used by
`bash.compound.read`:

```json
{
  "all": [
    { "compoundForm": "for" },
    { "bodyStagesAllReadOnly": true },
    { "noBodySubstitution": true },
    { "noBodyShellWrap": true },
    { "noBodyRedirectTo": true },
    { "iteratorScopesAllIn": { "scopes": ["project", "writable-project", "temp"] } },
    { "bodyStagesAllScopeIn": { "scopes": ["project", "writable-project", "temp"] } }
  ]
}
```

Allow rules that use compound-body matchers must use that exact approved bundle. A missing guard,
brace-group/conditional allow, widened scope set, diagnostic-bearing allow, or non-conjunctive
wrapper fails load-time sealed-floor validation. Review rules can use narrower compound matchers
and `diagnosticCode` to attach specific reasons; diagnostic-bearing shapes never produce an allow.

## Removed executable rule modules

Trusted TypeScript rule modules were cut from Pi Clearance before public release. Clearance
never discovers, loads, executes, registers, or enables TypeScript policy modules. Existing
trust records and module descriptors are inert, and removed configuration keys fail strict
validation. Use inspectable data packs or propose a core matcher instead; both remain visible
to sealed-floor overlap validation and replay.

## Distribution through Pi packages

Pack collections can ship as Pi packages from npm, git, or local paths. A package may ship:

- data-pack JSON or TypeScript source that exports data packs;
- pack metadata, including warning text and docs links;
- docs that explain the package's pack boundaries and examples;
- thin skills that point agents to these docs;
- an extension that registers packs with Pi Clearance.

Package-distributed collection checklist:

- keep reusable policy in data packs whenever possible;
- include metadata title, description, tags, docs links, and warnings for risky packs;
- document what the pack may newly allow, review, or deny;
- register synchronously on the pack request event;
- unsubscribe request listeners on `session_shutdown`;
- never imply installation enables policy.

Installing a Pi package makes contributed packs discoverable. It does not enable them. Users
enable package pack ids through user-owned global or project `packEnablement.enabledPackagePacks`,
usually via `/clearance packs`. Live Pi tune tools replay and validate package-pack
enablement against the current package-registration snapshot collected from the event bus. A
helper or offline replay path that lacks such a snapshot is lower fidelity: it marks package
candidate replay/adversarial evidence as structured `not-run` pending evidence, or uses an
explicit serialized snapshot when that path provides one. Disabling a package pack writes
user-owned `disabledPackagePacks`; it does not uninstall the Pi package or delete the
package's registration code. User-authored raw packs stay in the config `packs` array and can
be suppressed with `disabledConfigPacks` while remaining listable.

Local workflow helpers belong in this user-owned layer. For example, a project that repeatedly
uses `.work/bin/work-view` should either add a narrow project overlay rule for that exact helper
or publish a package-contributed pack that users explicitly enable. Do not treat machine-specific
helper paths as shipped baseline policy.

The same v1 event-bus contract works for npm, git, and local packages because Pi loads the
package extension in all three cases. v1 contributors should emit their registration
synchronously inside the request handler; asynchronous discovery may miss the collection window.
They should also unsubscribe the request listener on `session_shutdown` so `/reload` does not
leave stale package listeners on Pi's persistent event bus.

Minimal registration extension:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AUTO_REVIEWER_PACKS_REGISTER_EVENT,
  AUTO_REVIEWER_PACKS_REQUEST_EVENT,
  type AutoReviewerPackRegistrationRequest,
} from "pi-clearance/pack-registration";
import { myPack } from "./packs/my-pack.ts";
import packageJson from "../package.json" with { type: "json" };

export default function registerAutoReviewerPacks(pi: ExtensionAPI) {
  const unsubscribePackRequests = pi.events.on(
    AUTO_REVIEWER_PACKS_REQUEST_EVENT,
    (event) => {
      const request = event as AutoReviewerPackRegistrationRequest;
      pi.events.emit(AUTO_REVIEWER_PACKS_REGISTER_EVENT, {
        apiVersion: 1,
        requestId: request.requestId,
        package: {
          name: packageJson.name,
          version: packageJson.version,
          installKind: "npm",
          packagePath: new URL("..", import.meta.url).pathname,
        },
        packs: [{ kind: "data-pack", pack: myPack }],
      });
    },
  );

  pi.on("session_shutdown", () => {
    unsubscribePackRequests();
  });
}
```

Package provenance fields (`name`, `version`, `installKind`, `sourceSpec`, `packagePath`,
`entrypointPath`) are display and audit context supplied by installed package code. They help
users identify which package contributed a pack; they are not a trust decision and do not make
rules active.

Pack metadata docs links are display links. Relative links are interpreted relative to the
contributing package root for UI/docs presentation, while HTTP links remain external.
Registration never fetches docs, follows links, or inspects package files beyond the event
payload.

Duplicate pack ids are not merged: the registry warns, the id is ambiguous, and lookup returns
no unique entry. Malformed registrations or invalid data packs are skipped with structured
issues. For contributors that honor the shutdown lifecycle, `/reload` recollects package state
so removed or fixed package contributions disappear or reappear on the next resolved registry

## Validation checklist

Before recommending a pack, the agent should:

- validate the pack schema, provenance, and source;
- compose it with the effective policy;
- check allow rules against the sealed floor;
- replay the full captured corpus without executing commands;
- show baseline-versus-candidate decision deltas from the structured replay payload, not from
  markdown wording;
- generate adversarial near-miss cases for new allow rules;
- show exact diffs or file writes;
- show the exact `packEnablement` patch and required warning acknowledgments;
- ask the user before enabling or writing config.

Related docs:

- [RULE_PACKS.md](RULE_PACKS.md)
- [CONFIGURATION.md](CONFIGURATION.md)
- [TUNE.md](TUNE.md)
- [SPEC.md](SPEC.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
