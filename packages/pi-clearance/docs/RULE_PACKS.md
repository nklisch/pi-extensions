# Rule packs

Rule packs are inspectable policy modules. The interpreter applies the sealed floor first, then active packs with fixed precedence `deny > review > allow`.

## Baseline

Every mode uses the same built-in baseline. It contains the former default pack set:

- shell inspection/search/VCS and safe composition;
- expanded inspection, shell-builtin, and system/service read packs;
- risky and compound-shell review gates;
- project/temp constructive commands and read-only compound loops;
- typed Pi inspection, file mutation, extension inspection, and workflow packs;
- development verification and package workflows;
- `bash.vcs.read` Git read plumbing and inspection forms, plus
  `bash.vcs.write` routine local Git writes;

### Git coverage and leading options

`bash.vcs.read` allows the read-only plumbing commands `rev-parse`, `blame`,
`grep`, `ls-tree`, `cat-file`, `merge-base`, `describe`, `shortlog`,
`show-ref`, `check-ignore`, `name-rev`, `count-objects`, `ls-remote`,
`diff-tree`, and `diff-index`. It also covers branch/tag listing and local
creation without destructive flags, `remote -v/show/get-url`, read-only
`config --get/--list`, `stash list`, and `worktree list`. A bare `git remote`
is intentionally not expressible by the v1 matcher vocabulary and remains
review-gated; remote mutation remains review-gated as well. The bare-git
remote limitation applies only to that no-subcommand inspection form, not to
`remote -v`, `remote show`, or `remote get-url`.

`bash.vcs.write` allows routine local `add`, `commit` (including `--amend`),
`fetch`, `pull` (including `--rebase`), `merge`, `switch` without force flags,
and `checkout -b`. `push` remains review wholesale. Reset and clean remain
review wholesale, as do destructive branch/tag/checkout/switch variants and
all stash, worktree, and remote mutations. Git write families are excluded
from v1 heterogeneous composition, so a chain such as `git add . && git
commit -m msg` remains review.

The parser projects supported Git leading options before policy matching:
`-C <path>`, `--git-dir[=<path>]`, `--work-tree[=<path>]`, `--no-pager`, and
`--literal-pathspecs`. This makes the real subcommand available at argument
index zero for direct rules and read-only composition. Refused or unknown
leading options—including `-c`, `--config-env`, `-P`/`--paginate`,
`--exec-path`, `--bare`, bundled `-C/path`, and unknown options—leave the
stage untouched and emit `bash:leading-option-unmodeled`, so they fail closed
to review. Successful projection emits the informational
`bash:leading-options-stripped` diagnostic; it does not block an otherwise
eligible allow.

The baseline also includes the formerly permissive-only network and home surfaces:

- `bash.network.read`;
- `pi.extension.network-research`;
- `pi.home.safe`.

Typed Pi `read`, `ls`, `find`, `grep`, `fffind`, and `ffgrep` calls are baseline-allowable when every path fact is proven inside project/temp, non-secret `home`, or `agent-support` scope. `safe-home` remains covered by the home pack, while typed mutations remain `safe-home`-only. The non-secret home read decision is intentionally baseline-wide now that postures are gone: the sealed floor remains non-overridable, and the sensitive-home catalog is the explicit carveout for credential harbors. System and outside paths therefore remain review-gated. Denied, unknown, and sensitive-home paths are governed by the config-derived `config.scope.behavior` rules: configured denied directories deny outright, while unknown and sensitive-home paths are ceilings that review or deny per `projectScope` behavior fields.

Mode is a review-dispatch choice, not a policy-pack selector. Conditional extension packs activate only when their owning tools are registered. Package-contributed packs are available for discovery but never active until user-owned `packEnablement.enabledPackagePacks` explicitly enables them.

### Embedded shell extension boundaries

`background` and `monitor` are analyzed as typed extension tools, but their
`command` string is projected into a nested `BashCommandShape`. `decide()`
evaluates that inner shape through the ordinary sealed-floor, review, and allow
pipeline; it does not redispatch a synthetic bash tool call. Consequently,
`background({ command: "pnpm test" })` can use the shipped development pack,
while an inner privilege-escalation or other sealed-floor command is denied
before wrapper policy is considered.

The projection accepts an optional finite non-negative `timeout` as a resource
bound. An optional `workingDirectory` (also accepted as `working-directory` or
`cwd`) must classify inside the configured project or writable-project scope;
missing, dynamic, system, temporary, or outside-project directories remain
review-gated. Unknown wrapper fields, missing/non-string commands, invalid
timeouts, and unparseable shell input fail closed. The
`pi.extension.review-boundaries` rule is therefore a fallback for an absent or
uncertain inner projection, not a blanket review of a command that the bash
policy can already decide.

## Sealed floor

`floor.deny` is always active and cannot be overridden by mode, user packs, repository policy, human approval, or model output. Its catastrophic stage rules use `stageSome` semantics: they inspect every modeled top-level command stage and every command stage in a fully modeled `for`, brace-group, or conditional body. Unsupported or unmodeled bodies retain their blocking diagnostics and fall to review. Commands hidden inside substitutions are likewise review-gated until the parser projects substitution stages.

The shipped floor denies system-root deletion, privilege escalation, shutdown/reboot, `dd` writes whose `of=/dev/...` target is not a pseudo-device (`null`, `zero`, `full`, `random`, `urandom`, standard streams, or `fd/`), and the enumerated device-targeting `mkfs` family. Image-file formatting, `dd` reads, pseudo-device writes, and unlisted disk tools remain review-gated; `wipefs`, `shred`, `sgdisk`, `fdisk`, `parted`, and `zpool` are deliberate follow-up coverage. Every floor `stageSome` inner carries a concrete program anchor so allow/floor overlap can be checked conservatively; an allow-side `stageSome` remains overlap-unknown and is rejected at load time.

## Pack explorer

`/clearance packs` shows baseline, configured, package, and sealed-floor entries. Explorer state uses baseline vocabulary: sealed floor, baseline, enabled config, available, disabled, missing, or ambiguous. It no longer exposes profile membership or posture filters.

## Authoring

A pack is a versioned object with `id`, optional inert metadata, and rules:

```json
{
  "version": 1,
  "id": "user-project.reads",
  "rules": [
    {
      "id": "read-docs",
      "effect": "allow",
      "match": { "all": [{ "tool": "bash" }, { "program": "cat" }] },
      "reason": "read project documentation",
      "provenance": { "source": "user-project" }
    }
  ]
}
```

Allow rules must be statically disjoint from the sealed floor. Unknown overlap rejects the pack. Repository packs are tighten-only unless Pi reports the project as trusted. Trusted TypeScript rule modules are cut; only inspectable data packs are loadable.

## Path and compound safety

Constructive allows should use path facts and require complete per-stage coverage. Unknown, home, outside, system, and denied facts never satisfy a project-local allow. Compound-shell allows require modeled form, read-only body effects, safe iterator/body scopes, no substitution, no shell wrapping, and no output redirects.

The development-verification pack also allows routine formatter writes when every
formatter file operand is proven inside `project`, `writable-project`, or `temp`:
`cargo fmt`, `biome --write`, `prettier --write`, `ruff check --fix`, and
`eslint --fix`. A bare `cargo fmt` uses the configured current project root as
its scope proof; path-bearing forms require path facts. Config, plugin, rules,
parser, output, manifest, and unstable-option escape flags remain review-gated,
as do out-of-scope or dynamic operands. `go fmt` remains review-gated. These
write rules are direct command allows, not read-only composition families.

## Bash environment and wrapper safety

The baseline review pack screens command-stage environment assignments before
allow rules are selected. Exact names, `LD_`/`DYLD_`/`GIT_CONFIG_` and
`CARGO_TARGET_` namespaces, and case-insensitive `npm_config_` names route to
review; benign assignments such as `FOO=1` remain eligible for their normal
allow rules. This is a review-tier gate, not a sealed-floor deny.

Package-runner coverage includes the pnpm dialect and matching npm/yarn script
posture. Supported pnpm global options are projected before policy matching, so
`--filter`, `--dir`, and workspace flags expose the real subcommand; unknown
options and `-g`/`--global` remain review-gated. The leading `--dir` behavior
intentionally follows pnpm's project-selection grammar, including its
cross-project lifecycle-script trust trade-off. Script-shaped pnpm/npm/yarn
shorthands are equivalent to `run <script>` for project-local workflows, while
named mutating pnpm subcommands and remote `dlx` execution remain review. The
`pnpm exec` wrapper projects its target through the complete floor and pack
pipeline (including environment screening and trusted `node_modules/.bin`
basename reduction); `dlx` is never projected. Read-only package information
such as `pnpm list`, `why`, `outdated`, `audit`, `view`, `config list`, and
`--version` is eligible for the read-only composition family, except audit
fix forms.

The expanded inspection baseline includes filesystem metadata, checksum,
process, date, hostname, and shell-state inspection. `bash.shell.builtins`
handles literal `export`, safe `set` options, tests, `command -v/-V`, and lone
`cd`; bare `export`/`export -p`, `printenv`, and bare `env` remain review-gated.
`bash.system.read` handles journalctl and bounded Docker/Podman inspection; systemctl
inspection/listing, journal mutation, remote systemctl flags, container log follow, and
streaming stats remain review-gated. Systemctl read forms intentionally cannot be
allow-loaded while the sealed shutdown floor uses a program-level existential witness.

The parser projects a bounded set of literal wrappers to the inner command so
the same floor, registry, path facts, and packs classify it: benign `env`
options (`-u`/`--unset` and `-i`), literal `timeout` durations, `rustup run`
with a literal toolchain, and trusted system-bin paths including
`/usr/local/bin`. Unrecognized wrapper options, dynamic durations/programs,
bare `env`, and `printenv` stay review-gated. Each successful projection emits
an informational `bash:stage-unwrapped` diagnostic for provenance; the
information diagnostic itself does not block an otherwise eligible allow.

Registry conditions are also compiled into direct read-only pack guards. This
keeps execution-capable flags such as ripgrep preprocess/replacement options,
`find` output actions, sort compressors/output flags, and tail follow modes out
of the read-only allow surface while their named review rules explain the gate.

## Heterogeneous read-only composition

The baseline `bash.structure.safe` pack has derived composition allows for
multi-stage commands. Every command stage must independently match a read-only
or dev-verification family; a single unknown, mutating, or review-gated stage
vetoes the composition. The ordinary v1 table includes inspection,
search/filter, Git/GitHub read, development verification, system/service reads,
shell builtins, `sed -n`, and the `true`/`:` no-ops. Network families remain
available for ordinary composition, but are deliberately excluded from benign
output-redirect tolerance: `curl URL > file` is equivalent to network fetch
plus local write and stays review-gated. Package-manager mutation workflows
(`bash.packages.common`) and constructive writes are intentionally not family
members.

Only `and` and `seq` are freely composable. A final `|| true` or `|| :` is
accepted only when the fallback is the penultimate operator's final block and
is a bare, resolvable no-op with no arguments, flags, environment assignments,
substitutions, redirects, pipeline, or background execution. `minStages: 2`
keeps single-stage commands with their owning pack's provenance. Stage-level
review and deny rules retain global precedence over the composition allow.

Benign output redirects are a separate narrow allow: literal temp/project
paths and `/dev/null` are eligible, while `.git` segments, unknown file
descriptors, dynamic targets, and cwd-relative paths outside the project stay
review-gated. `$TMPDIR/x` is supported only when the command does not assign
`TMPDIR`; `go fmt` and node debug-listener flags remain review-gated.

See [PACK_AUTHORING.md](PACK_AUTHORING.md) for matcher and registration details.
