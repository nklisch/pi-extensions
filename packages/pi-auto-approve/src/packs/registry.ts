import type { ResolvedConfig } from "../config/loader.ts";
import type { RawPolicyPack } from "../config/schema.ts";
import type {
  DecisionEffect,
  PolicyPack,
  PolicyPackDocLink,
  PolicyPackExample,
  PolicyPackMetadata,
  PolicyPackWarning,
} from "../policy/core.ts";
import { compilePack } from "../policy/core.ts";
import { isShippedPackActivationSatisfied } from "./activation.ts";
import { baselinePacks } from "./baseline.ts";
import { bashCompoundReadPack } from "./bash.compound.read.ts";
import { bashDevVerifyPack } from "./bash.dev.verify.ts";
import { bashInspectCorePack } from "./bash.inspect.core.ts";
import { bashNetworkReadPack } from "./bash.network.read.ts";
import { bashPackagesCommonPack } from "./bash.packages.common.ts";
import { bashProjectConstructivePack } from "./bash.project.constructive.ts";
import { bashReviewCompoundPack } from "./bash.review.compound.ts";
import { bashReviewRiskyPack } from "./bash.review.risky.ts";
import { bashSearchReadPack } from "./bash.search.read.ts";
import { bashStructureSafePack } from "./bash.structure.safe.ts";
import { bashVcsReadPack } from "./bash.vcs.read.ts";
import { bashVcsWritePack } from "./bash.vcs.write.ts";
import { sealedFloor } from "./floor.ts";
import type {
  NormalizedPackagePack,
  PackageInstallKind,
} from "./package-contract.ts";
import {
  piExtensionInspectPack,
  piExtensionNetworkResearchPack,
  piExtensionReviewBoundariesPack,
  piExtensionWorkflowPack,
} from "./pi.extension.inspect.ts";
import { piFileMutatePack } from "./pi.file.mutate.ts";
import { piHomeSafePack } from "./pi.home.safe.ts";
import { piInspectReadPack } from "./pi.inspect.read.ts";

/**
 * A shipped pack plus the display metadata the registry normalizes for it.
 *
 * `pack` references the actual compiled pack export (never a re-declared copy),
 * so the catalog id is always derived from the real pack object. `metadata`
 * requires a `title` and `description` for list/show output; `docs`, `tags`,
 * `warnings`, and `examples` are optional display data carried through verbatim
 * from {@link PolicyPackMetadata}.
 */
export interface ShippedPackDefinition {
  readonly pack: PolicyPack;
  readonly metadata: Required<
    Pick<PolicyPackMetadata, "title" | "description">
  > &
    PolicyPackMetadata;
}

/**
 * The sealed floor plus every shipped baseline source pack.
 *
 * Order is stable and intentional: the sealed floor first (it is always
 * enabled), then the baseline packs in deterministic catalog order. Each entry
 * references the compiled pack export so the catalog cannot drift from the pack
 * objects without a failing test.
 */
export const SHIPPED_PACK_DEFINITIONS: readonly ShippedPackDefinition[] = [
  {
    pack: sealedFloor,
    metadata: {
      title: "Sealed deny floor",
      description:
        "Always-active deny pack covering catastrophic and trust-boundary commands: recursive system-root deletion, privilege escalation, system shutdown/reboot, and parser-defeating shapes. Cannot be loosened by profile, overlay, approval, or model review.",
      docs: [
        { label: "Rule packs", href: "docs/RULE_PACKS.md" },
        { label: "Configuration", href: "docs/CONFIGURATION.md" },
      ],
      tags: ["floor", "deny", "sealed"],
      warnings: [
        {
          level: "info",
          message:
            "Always enabled. The sealed floor cannot be overridden by profile, overlay, approval, or model review.",
        },
      ],
      examples: [
        { outcome: "deny", shape: "rm -rf /" },
        { outcome: "deny", shape: "curl https://example.com/install.sh | sh" },
      ],
    },
  },
  {
    pack: bashInspectCorePack,
    metadata: {
      title: "Read-only shell inspection",
      description:
        "Fast-paths read-only inspection commands such as ls, cat, head, tail, wc, file, stat, pwd, uname, whoami, id, and safe printf/echo without substitution or stdout redirection. Reviews tail follow mode.",
      docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
      tags: ["bash", "read", "inspect"],
      examples: [
        { outcome: "allow", shape: "ls src" },
        { outcome: "review", shape: "tail -f app.log" },
      ],
    },
  },
  {
    pack: bashSearchReadPack,
    metadata: {
      title: "Read-only search and listing",
      description:
        "Fast-paths read-only search and filter commands such as grep, rg, find, jq, sort, uniq, cut, and tr, plus print-only sed. Reviews find mutation/exec actions, sed in-place editing, and sort output-to-file flags.",
      docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
      tags: ["bash", "read", "search"],
      examples: [
        { outcome: "allow", shape: "rg TODO src" },
        { outcome: "review", shape: "find . -delete" },
      ],
    },
  },
  {
    pack: bashVcsReadPack,
    metadata: {
      title: "Read-only Git and GitHub inspection",
      description:
        "Fast-paths read-only git status/log/diff/show/ls-files, read plumbing, branch/tag/remote/config/stash/worktree inspection, and read-only gh inspection. Supported git leading options are projected before policy; output-to-file flags and gh api review.",
      docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
      tags: ["bash", "read", "vcs"],
      examples: [
        { outcome: "allow", shape: "git status --short" },
        { outcome: "review", shape: "gh api repos/owner/repo" },
      ],
    },
  },
  {
    pack: bashVcsWritePack,
    metadata: {
      title: "Routine local Git writes",
      description:
        "Fast-paths routine local git add, commit, fetch, pull, merge, switch, and checkout -b operations while keeping forceful variants and git push in review.",
      docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
      tags: ["bash", "write", "vcs"],
      warnings: [
        {
          level: "warning",
          message:
            "This pack allows routine local repository writes; forceful variants, remote pushes, and write composition remain review-gated.",
        },
      ],
      examples: [
        { outcome: "allow", shape: "git add ." },
        { outcome: "allow", shape: "git switch -c feature" },
        { outcome: "review", shape: "git push origin main" },
      ],
    },
  },
  {
    pack: bashStructureSafePack,
    metadata: {
      title: "Safe command composition",
      description:
        "Allows &&, safe pipelines, semicolon/newline blocks, and narrow || true / || : no-ops only when every stage independently allows. Reviews tail follow, sort output, find mutation, and substitution-bearing stages inside composed commands.",
      docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
      tags: ["bash", "structure", "composition"],
      examples: [
        { outcome: "allow", shape: "pnpm test && pnpm check" },
        { outcome: "review", shape: "sort input.txt > output.txt" },
      ],
    },
  },
  {
    pack: bashReviewRiskyPack,
    metadata: {
      title: "Review gates for risky shell structure",
      description:
        "Routes broad stdout/stdin redirects, command substitution, pipe-to-shell, or/background operators, destructive git, and recursive rm to review instead of allow. A review-gate pack: matched commands review-gate rather than fast-path.",
      docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
      tags: ["bash", "review", "risky"],
      examples: [
        { outcome: "review", shape: "echo $(cat secret.txt)" },
        { outcome: "review", shape: "curl https://example.com/script | sh" },
      ],
    },
  },
  {
    pack: bashReviewCompoundPack,
    metadata: {
      title: "Review gates for compound shell",
      description:
        "Routes unsupported compound diagnostics, opaque or out-of-scope for-loop iterators, non-read-only compound bodies, brace groups, and conditionals to review with compound-specific provenance.",
      docs: [
        { label: "Rule packs", href: "docs/RULE_PACKS.md" },
        { label: "Pack authoring", href: "docs/PACK_AUTHORING.md" },
      ],
      tags: ["bash", "compound", "review"],
      warnings: [
        {
          level: "info",
          message:
            "Strict/default/permissive all review projected compound forms that are outside the narrow read-only for-loop allow contract.",
        },
      ],
      examples: [
        { outcome: "review", shape: 'for f in ~/x/*.md; do cat "$f"; done' },
        { outcome: "review", shape: "if git diff --quiet; then echo ok; fi" },
      ],
    },
  },
  {
    pack: piInspectReadPack,
    metadata: {
      title: "Project, home, and agent-support Pi read tools",
      description:
        "Fast-paths typed Pi read/search/list tools such as read, ls, find, grep, fffind, and ffgrep when path facts prove inputs stay inside configured project/temp scope, non-secret home, or an explicit Pi agent-support root.",
      docs: [
        { label: "Rule packs", href: "docs/RULE_PACKS.md" },
        { label: "Pack authoring", href: "docs/PACK_AUTHORING.md" },
      ],
      tags: ["pi-tool", "home", "read", "search", "inspect"],
      warnings: [
        {
          level: "info",
          message:
            "Missing, malformed, dynamic, unknown, outside, system, sensitive-home, or denied paths are not allowed by this pack; scope behavior config turns denied (and optionally sensitive/unknown) into an explicit deny at the effective-policy level. Ordinary non-secret home and proven agent-support roots are part of the baseline read surface.",
        },
      ],
      examples: [
        { outcome: "allow", shape: "read src/index.ts" },
        { outcome: "allow", shape: "read ~/Documents/notes.md" },
        { outcome: "review", shape: "read ~/.ssh/id_rsa" },
        { outcome: "review", shape: "read /etc/passwd" },
      ],
    },
  },
  {
    pack: piFileMutatePack,
    metadata: {
      title: "Built-in project file edits",
      description:
        "Fast-paths typed Pi edit/write tools only when mutation facts prove a well-formed project-scoped target with no trust-boundary crossing; sensitive targets review with typed provenance.",
      docs: [
        { label: "Rule packs", href: "docs/RULE_PACKS.md" },
        { label: "Pack authoring", href: "docs/PACK_AUTHORING.md" },
      ],
      tags: ["pi-tool", "mutation", "write", "project-scope"],
      warnings: [
        {
          level: "info",
          message:
            "Missing mutation facts, absent trust-boundary facts, dynamic/unknown paths, non-project scopes, denied paths, and policy/config/hook/package-script targets are not allowed by this pack; configured denied directories deny outright at the effective-policy level.",
        },
      ],
      examples: [
        { outcome: "allow", shape: "edit src/policy/core.ts" },
        { outcome: "review", shape: "write .pi/hooks/approve.ts" },
      ],
    },
  },
  {
    pack: piExtensionInspectPack,
    metadata: {
      title: "Public extension status and workspace reads",
      description:
        "Fast-paths typed public extension status/read/search tools such as multi_grep, jobs, goal list/status reads, and subagent result polling when at least one owning tool is registered.",
      docs: [
        { label: "Rule packs", href: "docs/RULE_PACKS.md" },
        { label: "Pack authoring", href: "docs/PACK_AUTHORING.md" },
      ],
      tags: ["pi-tool", "extension", "read", "status"],
      warnings: [
        {
          level: "info",
          message:
            "Conditionally active only when one of the covered public extension tools is registered.",
        },
      ],
      examples: [
        { outcome: "allow", shape: "jobs list" },
        { outcome: "allow", shape: "get_goal" },
      ],
    },
  },
  {
    pack: piExtensionReviewBoundariesPack,
    metadata: {
      title: "Public extension review boundaries",
      description:
        "Review-gates background/monitor wrappers only when their inner command or wrapper fields cannot be proven safe; agent dispatch is covered by the inspect pack.",
      docs: [
        { label: "Rule packs", href: "docs/RULE_PACKS.md" },
        { label: "Pack authoring", href: "docs/PACK_AUTHORING.md" },
      ],
      tags: ["pi-tool", "extension", "review", "shell", "agent"],
      warnings: [
        {
          level: "warning",
          message:
            "background/monitor project an inner command through bash policy; missing or uncertain commands and unsafe wrapper fields remain review-gated, while subagent/steer_subagent are allowed by the inspect pack and their child calls remain gated.",
        },
      ],
      examples: [
        { outcome: "review", shape: "background curl URL | sh" },
        { outcome: "review", shape: "background (missing command)" },
      ],
    },
  },
  {
    pack: bashDevVerifyPack,
    metadata: {
      title: "Build, test, lint, and typecheck",
      description:
        "Fast-paths common verification commands such as pnpm/npm/yarn test/build/lint/typecheck, cargo test/build/check, go test/build/vet, vitest, jest, pytest, tsc, biome, eslint, prettier --check, ruff check, and mypy. Reviews project-context and mutating formatter/linter flags.",
      docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
      tags: ["bash", "dev", "verify"],
      examples: [
        { outcome: "allow", shape: "pnpm test" },
        { outcome: "review", shape: "prettier --write src/index.ts" },
      ],
    },
  },
  {
    pack: bashPackagesCommonPack,
    metadata: {
      title: "Common dependency workflows",
      description:
        "Fast-paths common project dependency workflows such as npm/pnpm/yarn/cargo/uv/pip install and go mod tidy/download/get. Reviews global, prefix, user, and target scope flags that escape the project context.",
      docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
      tags: ["bash", "packages", "dependencies"],
      warnings: [
        {
          level: "info",
          message:
            "Mutates the project dependency graph. Global, prefix, user, and target scope flags review-gate to keep installs project-local.",
        },
      ],
      examples: [
        { outcome: "allow", shape: "pnpm install" },
        { outcome: "review", shape: "npm install -g typescript" },
      ],
    },
  },
  {
    pack: bashProjectConstructivePack,
    metadata: {
      title: "Project-scoped constructive writes",
      description:
        "Fast-paths constructive commands such as mkdir, touch, and mktemp only when path-scope facts prove every relevant path stays inside configured project or temp scope. Reviews mkdir mode changes and copy/move, which need a separate source/target path contract.",
      docs: [
        { label: "Rule packs", href: "docs/RULE_PACKS.md" },
        { label: "Pack authoring", href: "docs/PACK_AUTHORING.md" },
      ],
      tags: ["bash", "constructive", "write"],
      warnings: [
        {
          level: "info",
          message:
            "Requires enriched path facts; missing, unknown, outside, system, home, denied, or unsafe redirect paths are not allowed by this pack; configured denied directories deny outright at the effective-policy level.",
        },
      ],
      examples: [
        { outcome: "allow", shape: "mkdir -p test/fixtures" },
        { outcome: "review", shape: "mkdir -m 777 tmp" },
      ],
    },
  },
  {
    pack: bashCompoundReadPack,
    metadata: {
      title: "Read-only compound for-loops",
      description:
        "Fast-paths the narrow compound-shell case of projected for-loops over project/temp-scoped literal iterators when every body stage is read-only, project/temp scoped, and free of substitutions, shell wraps, and output-file redirects.",
      docs: [
        { label: "Rule packs", href: "docs/RULE_PACKS.md" },
        { label: "Pack authoring", href: "docs/PACK_AUTHORING.md" },
      ],
      tags: ["bash", "compound", "read"],
      warnings: [
        {
          level: "info",
          message:
            "Default/permissive only. Strict keeps compound shell forms in review, and any missing path facts or body proof fails closed to review.",
        },
      ],
      examples: [
        {
          outcome: "allow",
          shape:
            "for f in .work/backlog/*.md; do echo '---' \"$f\"; sed -n '1,120p' \"$f\"; done",
        },
        { outcome: "review", shape: 'for f in /etc/*.conf; do cat "$f"; done' },
      ],
    },
  },
  {
    pack: piExtensionWorkflowPack,
    metadata: {
      title: "Public extension workflow tools",
      description:
        "Fast-paths bounded public extension workflow tools such as todo, ask_user_question, and pi-goals lifecycle/queue operations when their owning tools are registered.",
      docs: [
        { label: "Rule packs", href: "docs/RULE_PACKS.md" },
        { label: "Pack authoring", href: "docs/PACK_AUTHORING.md" },
      ],
      tags: ["pi-tool", "extension", "workflow", "mutation"],
      warnings: [
        {
          level: "info",
          message:
            "These tools mutate extension-owned session/workflow state only; arbitrary file, shell, network, and external-system writes remain out of scope.",
        },
      ],
      examples: [
        { outcome: "allow", shape: "todo add implementation task" },
        { outcome: "allow", shape: "ask_user_question choose posture" },
      ],
    },
  },
  {
    pack: bashNetworkReadPack,
    metadata: {
      title: "Network reads and downloads",
      description:
        "Fast-paths curl and wget network reads without substitution or redirection. Reviews method overrides, request bodies, uploads, credential-bearing flags, and explicit output paths.",
      docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
      tags: ["bash", "network", "read"],
      warnings: [
        {
          level: "warning",
          message:
            "Network access pack, available only in the built-in baseline. Credential-bearing, upload, and explicit-output-path flags review-gate.",
        },
      ],
      examples: [
        { outcome: "allow", shape: "curl https://example.com" },
        { outcome: "review", shape: "curl -o out.txt https://example.com" },
      ],
    },
  },
  {
    pack: piExtensionNetworkResearchPack,
    metadata: {
      title: "Public extension network research tools",
      description:
        "Fast-paths typed Z.ai and Umans web/repo/content research reads in the built-in baseline when the corresponding provider tools are registered.",
      docs: [
        { label: "Rule packs", href: "docs/RULE_PACKS.md" },
        { label: "Pack authoring", href: "docs/PACK_AUTHORING.md" },
      ],
      tags: ["pi-tool", "extension", "network", "research"],
      warnings: [
        {
          level: "warning",
          message:
            "Provider/network/privacy boundary: this pack is limited to the built-in baseline and only covers typed read/research tools, not external mutations.",
        },
      ],
      examples: [
        { outcome: "allow", shape: "zai_web_search current TypeScript" },
        { outcome: "allow", shape: "fetch_content docs URL" },
      ],
    },
  },
  {
    pack: piHomeSafePack,
    metadata: {
      title: "Safe-home Pi file tools",
      description:
        "Fast-paths typed Pi read/search/list and bounded edit/write tools in the built-in baseline when path and mutation facts prove inputs stay inside configured safe-home directories and mutations cross no trust boundary; broader non-secret home reads are covered by pi.inspect.read.",
      docs: [
        { label: "Rule packs", href: "docs/RULE_PACKS.md" },
        { label: "Pack authoring", href: "docs/PACK_AUTHORING.md" },
      ],
      tags: ["pi-tool", "home", "safe-home", "mutation", "read"],
      warnings: [
        {
          level: "warning",
          message:
            "Safe-home is the only home scope for typed mutations. Sensitive-home paths, broad-home mutations, dynamic paths, malformed mutations, and trust-boundary targets fail closed to review; non-secret home reads use pi.inspect.read.",
        },
      ],
      examples: [
        { outcome: "allow", shape: "read ~/dev/notes.md" },
        { outcome: "allow", shape: "write ~/dev/generated.ts" },
        { outcome: "review", shape: "write ~/.ssh/config" },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Registry builder and query helpers
//
// Pure registry/query helpers that combine the shipped catalog, config-owned
// packs (user-global, user-project, repository), and package-contributed pack
// definitions into list/show/filter-ready entries. Availability is not
// enablement: every entry the registry knows about is available, but a pack is
// enabled only when selected by the sealed floor, the built-in baseline,
// user-owned config, or an explicitly enabled package id. These helpers never
// read the filesystem, prompt, or import Pi runtime APIs; they only normalize
// what callers pass in. The policy composer remains authoritative for the
// effective policy (trust stripping, fail-closed validation).
// ---------------------------------------------------------------------------

/** Provenance classes for registry entries. Mirrors the runtime decision sources. */
export const PACK_SOURCE_KINDS = [
  "shipped",
  "user-global",
  "user-project",
  "trusted-repo",
  "package",
] as const;
export type PackSourceKind = (typeof PACK_SOURCE_KINDS)[number];

export const PACK_EFFECT_SUMMARIES = [
  "deny-floor",
  "deny",
  "review-gate",
  "allow",
  "mixed",
  "unknown",
] as const;

export type PackEffectSummary = (typeof PACK_EFFECT_SUMMARIES)[number];

export type PackMetadataField =
  | "title"
  | "description"
  | "docs"
  | "tags"
  | "examples";

/** Raw metadata presence before registry fallback title/description defaults fill gaps. */
export interface PackMetadataCompleteness {
  readonly hasTitle: boolean;
  readonly hasDescription: boolean;
  readonly hasDocs: boolean;
  readonly hasTags: boolean;
  readonly hasExamples: boolean;
  readonly missingFields: readonly PackMetadataField[];
}

/** Where a registry entry came from. Package detail is set only for packages. */
export interface PackSourceInfo {
  readonly kind: PackSourceKind;
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly packagePath?: string;
  /** Install kind for package-contributed packs (npm/git/local/temporary/unknown). Set only for packages. */
  readonly packageInstallKind?: PackageInstallKind;
  /** Source spec for package-contributed packs (e.g. git URL or npm spec). Set only for packages. */
  readonly packageSourceSpec?: string;
  /** Entrypoint path for the contributing package extension. Set only for packages. */
  readonly packageEntrypointPath?: string;
}

/** Why a pack is enabled. */
export interface PackEnablement {
  readonly kind:
    | "sealed-floor"
    | "baseline"
    | "global-config"
    | "project-config"
    | "repo-policy"
    | "package-config";
  /** Reserved for future config/package provenance display; no current builder sets it. */
  readonly path?: string;
}

/** Availability state. Every registry entry is available; `enabled` is separate. */
export interface PackAvailability {
  readonly available: true;
  readonly enabled: boolean;
  readonly enabledBy: readonly PackEnablement[];
}

/** A normalized, display-ready pack entry. */
export interface PackRegistryEntry {
  readonly id: string;
  readonly pack: PolicyPack;
  readonly metadata: {
    readonly title: string;
    readonly description: string;
    readonly docs: readonly PolicyPackDocLink[];
    readonly tags: readonly string[];
    readonly warnings: readonly PolicyPackWarning[];
    readonly examples: readonly PolicyPackExample[];
  };
  readonly metadataCompleteness: PackMetadataCompleteness;
  readonly source: PackSourceInfo;
  readonly inBaseline: boolean;
  readonly availability: PackAvailability;
}

/** Optional filter for {@link listPackRegistryEntries}. All set fields AND together. */
export interface PackRegistryFilter {
  readonly source?: PackSourceKind;
  readonly inBaseline?: boolean;
  readonly enabled?: boolean;
  readonly tag?: string;
}

/** Built registry: entries plus warnings surfaced during construction. */
export interface PackRegistry {
  readonly entries: readonly PackRegistryEntry[];
  readonly warnings: readonly string[];
}

export interface PackagePackSelectionWarning {
  readonly code: "enabled-package-missing" | "enabled-package-ambiguous";
  readonly packId: string;
  readonly message: string;
}

export interface SelectedPackagePacks {
  readonly packs: readonly PolicyPack[];
  readonly enabledPackageIds: readonly string[];
  readonly warnings: readonly PackagePackSelectionWarning[];
}

/**
 * Select package-contributed packs explicitly enabled by user-owned config.
 *
 * Missing ids and duplicate package ids fail safe by contributing no active
 * package rules: skipping cannot widen policy, while guessing between packages
 * could run a pack the user did not mean to enable.
 */
export function selectEnabledPackagePacks(input: {
  readonly packagePacks: readonly NormalizedPackagePack[];
  readonly enabledPackageIds: readonly string[];
}): SelectedPackagePacks {
  const selected: PolicyPack[] = [];
  const selectedIds: string[] = [];
  const warnings: PackagePackSelectionWarning[] = [];

  for (const packId of input.enabledPackageIds) {
    const matches = input.packagePacks.filter(
      (contributed) => contributed.pack.id === packId,
    );
    if (matches.length === 0) {
      warnings.push({
        code: "enabled-package-missing",
        packId,
        message: `Enabled package pack "${packId}" is not registered; skipping it for this policy resolution.`,
      });
      continue;
    }

    if (matches.length > 1) {
      warnings.push({
        code: "enabled-package-ambiguous",
        packId,
        message: `Enabled package pack "${packId}" is ambiguous across ${matches.length} package registrations; skipping all matches.`,
      });
      continue;
    }

    const match = matches[0];
    if (match === undefined) {
      continue;
    }
    selected.push(match.pack);
    selectedIds.push(packId);
  }

  return { packs: selected, enabledPackageIds: selectedIds, warnings };
}

/**
 * Build a pack registry from resolved config plus optional package-contributed
 * pack definitions.
 *
 * Shipped entries come from {@link SHIPPED_PACK_DEFINITIONS}: the sealed floor
 * is always enabled, and each shipped source pack is enabled when it is in
 * the built-in baseline and its activation condition is satisfied. User-owned config packs (user-global,
 * user-project) are available and enabled because their config source already
 * selected them unless their id appears in the resolved or explicit
 * `disabledConfigPackIds` list; disabled entries remain listable. Repository
 * packs are governed by repo trust/composition rather than user-authored pack
 * disablement, and they additionally surface a trust caveat when the project is
 * untrusted and the pack declares allow rules. Package-contributed packs are
 * available but disabled unless their id appears in `enabledPackageIds`.
 * Duplicate pack ids are not merged: a warning is emitted and
 * {@link getPackRegistryEntry} returns `undefined` for the ambiguous id.
 */
export function createPackRegistry(input: {
  readonly resolvedConfig: ResolvedConfig;
  readonly packagePacks?: readonly {
    readonly pack: PolicyPack;
    readonly source: PackSourceInfo & { readonly kind: "package" };
  }[];
  readonly enabledPackageIds?: readonly string[];
  readonly disabledConfigPackIds?: readonly string[];
  /** Registered Pi tool names used to activate conditional shipped extension packs. */
  readonly registeredToolNames?: readonly string[];
}): PackRegistry {
  const { resolvedConfig } = input;
  const enabledPackageIds = new Set(input.enabledPackageIds ?? []);
  const disabledConfigPackIds = new Set(
    input.disabledConfigPackIds ??
      resolvedConfig.packEnablement.disabledConfigPackIds,
  );
  const entries: PackRegistryEntry[] = [];
  const warnings: string[] = [];

  for (const definition of SHIPPED_PACK_DEFINITIONS) {
    const pack = definition.pack;
    if (pack === sealedFloor) {
      entries.push(
        buildEntry({
          pack,
          source: { kind: "shipped" },
          inBaseline: false,
          enabled: true,
          enabledBy: [{ kind: "sealed-floor" }],
          metadataSource: definition.metadata,
        }),
      );
      continue;
    }

    const inBaseline = baselinePacks.some(
      (candidate) => candidate.id === pack.id,
    );
    const activationSatisfied = isShippedPackActivationSatisfied(
      pack.id,
      input.registeredToolNames,
    );
    const enabled = inBaseline && activationSatisfied;
    entries.push(
      buildEntry({
        pack,
        source: { kind: "shipped" },
        inBaseline,
        enabled,
        enabledBy: enabled ? [{ kind: "baseline" }] : [],
        metadataSource: definition.metadata,
      }),
    );
  }

  appendConfigEntries({
    rawPacks: resolvedConfig.globalPacks,
    sourceKind: "user-global",
    enablementKind: "global-config",
    disabledConfigPackIds,
    entries,
    warnings,
  });
  appendConfigEntries({
    rawPacks: resolvedConfig.projectPacks,
    sourceKind: "user-project",
    enablementKind: "project-config",
    disabledConfigPackIds,
    entries,
    warnings,
  });
  appendConfigEntries({
    rawPacks: resolvedConfig.repoPacks,
    sourceKind: "trusted-repo",
    enablementKind: "repo-policy",
    disabledConfigPackIds: new Set(),
    entries,
    warnings,
    trustCaveat: !resolvedConfig.trustedProject.trusted,
  });

  for (const contributed of input.packagePacks ?? []) {
    const enabled = enabledPackageIds.has(contributed.pack.id);
    entries.push(
      buildEntry({
        pack: contributed.pack,
        source: contributed.source,
        inBaseline: false,
        enabled,
        enabledBy: enabled ? [{ kind: "package-config" }] : [],
      }),
    );
  }

  emitDuplicateIdWarnings(entries, warnings);

  return { entries, warnings };
}

/** List registry entries, optionally filtered. All set filter fields AND together. */
export function listPackRegistryEntries(
  registry: PackRegistry,
  filter?: PackRegistryFilter,
): readonly PackRegistryEntry[] {
  if (filter === undefined) {
    return registry.entries;
  }
  return registry.entries.filter((entry) => entryMatchesFilter(entry, filter));
}

/**
 * Return the unique entry for `id`, or `undefined` when the id is missing or
 * appears more than once (ambiguous). Duplicate ids are surfaced as registry
 * warnings at build time rather than silently merged.
 */
export function getPackRegistryEntry(
  registry: PackRegistry,
  id: string,
): PackRegistryEntry | undefined {
  const matches = registry.entries.filter((entry) => entry.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}

export function deriveEffectSummary(
  entry: PackRegistryEntry,
): PackEffectSummary {
  if (
    entry.id === "floor.deny" ||
    entry.availability.enabledBy.some(
      (enablement) => enablement.kind === "sealed-floor",
    )
  ) {
    return "deny-floor";
  }

  const effects = new Set<DecisionEffect>(
    entry.pack.rules.map((rule) => rule.effect),
  );
  if (effects.size === 0) {
    return "unknown";
  }
  if (effects.size === 1) {
    const [effect] = effects;
    switch (effect) {
      case "deny":
        return "deny";
      case "review":
        return "review-gate";
      case "allow":
        return "allow";
    }
  }
  return "mixed";
}

function buildEntry(params: {
  readonly pack: PolicyPack;
  readonly source: PackSourceInfo;
  readonly inBaseline: boolean;
  readonly enabled: boolean;
  readonly enabledBy: readonly PackEnablement[];
  readonly metadataSource?: PolicyPackMetadata;
}): PackRegistryEntry {
  const metadataSource = params.metadataSource ?? params.pack.metadata;
  return {
    id: params.pack.id,
    pack: params.pack,
    metadata: normalizeMetadata(params.pack, params.source, metadataSource),
    metadataCompleteness: metadataCompleteness(metadataSource),
    source: params.source,
    inBaseline: params.inBaseline,
    availability: {
      available: true,
      enabled: params.enabled,
      enabledBy: params.enabledBy,
    },
  };
}

/**
 * Compile and append config-owned packs. Config packs are schema-validated by
 * the loader before reaching the registry; a compile failure here is defensive
 * only — the entry is skipped and a warning is emitted so listing stays robust.
 * The composer remains authoritative for fail-closed policy.
 */
function appendConfigEntries(params: {
  readonly rawPacks: readonly RawPolicyPack[];
  readonly sourceKind: PackSourceKind;
  readonly enablementKind: "global-config" | "project-config" | "repo-policy";
  readonly disabledConfigPackIds: ReadonlySet<string>;
  readonly entries: PackRegistryEntry[];
  readonly warnings: string[];
  readonly trustCaveat?: boolean;
}): void {
  for (const rawPack of params.rawPacks) {
    const result = compilePack(rawPack);
    if (result.pack === null) {
      for (const error of result.errors) {
        params.warnings.push(
          `Pack "${error.packId ?? rawPack.id}" failed to compile at ${error.path}: ${error.message}`,
        );
      }
      continue;
    }

    const pack = result.pack;

    if (params.trustCaveat && rawPackHasAllowRules(rawPack)) {
      params.warnings.push(
        `Repository pack "${pack.id}" declares allow rules that the composer strips because the project is not trusted; only its deny/review rules take effect.`,
      );
    }

    const enabled = !params.disabledConfigPackIds.has(pack.id);
    params.entries.push(
      buildEntry({
        pack,
        source: { kind: params.sourceKind },
        inBaseline: false,
        enabled,
        enabledBy: enabled ? [{ kind: params.enablementKind }] : [],
      }),
    );
  }
}

/** Whether a raw pack declares any allow rule (mirrors the composer's check). */
function rawPackHasAllowRules(pack: RawPolicyPack): boolean {
  return pack.rules.some((rule) => rule.effect === "allow");
}

/**
 * Emit a warning for each pack id that appears more than once across all
 * entries, naming the distinct source kinds involved. Entries are not merged;
 * the ambiguous id simply yields `undefined` from {@link getPackRegistryEntry}.
 */
function emitDuplicateIdWarnings(
  entries: readonly PackRegistryEntry[],
  warnings: string[],
): void {
  const byId = new Map<string, PackRegistryEntry[]>();
  for (const entry of entries) {
    const list = byId.get(entry.id);
    if (list === undefined) {
      byId.set(entry.id, [entry]);
    } else {
      list.push(entry);
    }
  }

  for (const [id, group] of byId) {
    if (group.length <= 1) {
      continue;
    }
    const sourceList = [
      ...new Set(group.map((entry) => duplicateSourceLabel(entry.source))),
    ].join(", ");
    warnings.push(
      `Duplicate pack id "${id}" appears ${group.length} time(s) across sources [${sourceList}]; getPackRegistryEntry returns undefined for this id because it is ambiguous.`,
    );
  }
}

function duplicateSourceLabel(source: PackSourceInfo): string {
  if (source.kind !== "package") {
    return source.kind;
  }
  if (source.packageName !== undefined && source.packageVersion !== undefined) {
    return `package:${source.packageName}@${source.packageVersion}`;
  }
  if (source.packageName !== undefined) {
    return `package:${source.packageName}`;
  }
  if (source.packagePath !== undefined) {
    return `package:${source.packagePath}`;
  }
  return "package:unknown";
}

function normalizeMetadata(
  pack: PolicyPack,
  source: PackSourceInfo,
  metadata?: PolicyPackMetadata,
): PackRegistryEntry["metadata"] {
  const ruleCount = pack.rules.length;
  return {
    title: metadata?.title ?? defaultTitle(pack.id, source),
    description:
      metadata?.description ?? defaultDescription(pack.id, source, ruleCount),
    docs: metadata?.docs ?? [],
    tags: metadata?.tags ?? [],
    warnings: metadata?.warnings ?? [],
    examples: metadata?.examples ?? [],
  };
}

function metadataCompleteness(
  metadata: PolicyPackMetadata | undefined,
): PackMetadataCompleteness {
  const hasTitle = nonEmptyString(metadata?.title);
  const hasDescription = nonEmptyString(metadata?.description);
  const hasDocs = (metadata?.docs?.length ?? 0) > 0;
  const hasTags = (metadata?.tags?.length ?? 0) > 0;
  const hasExamples = (metadata?.examples?.length ?? 0) > 0;
  const fields: readonly [PackMetadataField, boolean][] = [
    ["title", hasTitle],
    ["description", hasDescription],
    ["docs", hasDocs],
    ["tags", hasTags],
    ["examples", hasExamples],
  ];
  return {
    hasTitle,
    hasDescription,
    hasDocs,
    hasTags,
    hasExamples,
    missingFields: fields
      .filter(([, present]) => !present)
      .map(([field]) => field),
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function defaultTitle(id: string, source: PackSourceInfo): string {
  return `${sourceLabel(source)} pack: ${id}`;
}

function defaultDescription(
  id: string,
  source: PackSourceInfo,
  ruleCount: number,
): string {
  const noun = ruleCount === 1 ? "rule" : "rules";
  return `${sourceLabel(source)} pack "${id}" with ${ruleCount} ${noun}.`;
}

function sourceLabel(source: PackSourceInfo): string {
  switch (source.kind) {
    case "shipped":
      return "Shipped";
    case "user-global":
      return "User-global";
    case "user-project":
      return "User-project";
    case "trusted-repo":
      return "Repository";
    case "package":
      return source.packageName ? `Package ${source.packageName}` : "Package";
  }
}

function entryMatchesFilter(
  entry: PackRegistryEntry,
  filter: PackRegistryFilter,
): boolean {
  if (filter.source !== undefined && entry.source.kind !== filter.source) {
    return false;
  }
  if (
    filter.inBaseline !== undefined &&
    entry.inBaseline !== filter.inBaseline
  ) {
    return false;
  }
  if (
    filter.enabled !== undefined &&
    entry.availability.enabled !== filter.enabled
  ) {
    return false;
  }
  if (filter.tag !== undefined && !entry.metadata.tags.includes(filter.tag)) {
    return false;
  }
  return true;
}
