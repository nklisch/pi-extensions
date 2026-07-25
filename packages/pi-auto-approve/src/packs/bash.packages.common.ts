import type { RawMatcher } from "./condition-guards.ts";
import { defineShippedPack } from "./define.ts";

const PNPM_MUTATING_SUBCOMMANDS = [
  "rm",
  "un",
  "uninstall",
  "unlink",
  "link",
  "ln",
  "prune",
  "publish",
  "pack",
  "deploy",
  "patch",
  "patch-commit",
  "store",
  "server",
  "import",
  "setup",
  "self-update",
  "create",
  "env",
  "rebuild",
  "doctor",
  "init",
  "upgrade",
  // `pnpm version <inc|x.y.z>` bumps package versions and can create git
  // commits/tags — a mutation, not a script (review blocker, 2026-07-23).
  "version",
] as const;

const PNPM_COMMON_SUBCOMMANDS = ["install", "add", "remove", "update"] as const;

const PNPM_READ_ONLY_INFO_SUBCOMMANDS = [
  "list",
  "ls",
  "why",
  "outdated",
  "audit",
  "view",
  "info",
] as const;

/** All pnpm subcommands named by shipped allow/review rules. */
export const PNPM_KNOWN_SUBCOMMANDS = [
  ...PNPM_COMMON_SUBCOMMANDS,
  ...PNPM_READ_ONLY_INFO_SUBCOMMANDS,
  ...PNPM_MUTATING_SUBCOMMANDS,
  "config",
  "exec",
  "dlx",
  "test",
  "build",
  "lint",
  "typecheck",
  "run",
  "run-script",
] as const;

const pnpmReadOnlyInfoSafety = () =>
  [
    { not: { flagMatches: { names: ["fix"] } } },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ] as const;

const PNPM_READ_ONLY_INFO_FAMILY: RawMatcher = {
  any: [
    {
      all: [
        { program: "pnpm" },
        { arg0In: [...PNPM_READ_ONLY_INFO_SUBCOMMANDS] },
        ...pnpmReadOnlyInfoSafety(),
      ],
    },
    {
      all: [
        { program: "pnpm" },
        { arg0In: ["config"] },
        { argAt: { index: 1, value: "list" } },
        ...pnpmReadOnlyInfoSafety(),
      ],
    },
    {
      all: [
        { program: "pnpm" },
        { flagPresent: "version" },
        ...pnpmReadOnlyInfoSafety(),
      ],
    },
  ],
};

/** Read-only pnpm information is safe to compose with other read-only stages. */
export const BASH_PACKAGES_PNPM_READ_INFO_FAMILY = PNPM_READ_ONLY_INFO_FAMILY;

const packageManagerRule = (
  id: string,
  program: string,
  subcommands: readonly string[],
  reason: string,
) => ({
  id,
  effect: "allow",
  match: {
    all: [
      { program },
      { arg0In: [...subcommands] },
      { noSubstitution: true },
      { noStdoutRedirect: true },
    ],
  },
  reason,
  provenance: { source: "shipped" },
});

const rawPack = {
  version: 1,
  id: "bash.packages.common",
  rules: [
    {
      id: "bash.packages.common:review-npm-global-or-prefix",
      effect: "review",
      match: {
        all: [
          { program: "npm" },
          {
            any: [
              { flagPresent: "g" },
              { flagPresent: "global" },
              { flagPresent: "prefix" },
            ],
          },
        ],
      },
      reason: "npm global or prefix-scoped installs require review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.packages.common:review-pnpm-global-or-dir",
      effect: "review",
      match: {
        all: [
          { program: "pnpm" },
          {
            any: [
              { flagPresent: "g" },
              { flagPresent: "global" },
              { flagPresent: "dir" },
            ],
          },
        ],
      },
      reason: "pnpm global or directory-scoped installs require review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.packages.common:review-pnpm-mutating-subcommands",
      effect: "review",
      match: {
        all: [{ program: "pnpm" }, { arg0In: [...PNPM_MUTATING_SUBCOMMANDS] }],
      },
      reason: "pnpm mutating or project-management subcommand requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.packages.common:review-pnpm-dlx",
      effect: "review",
      match: {
        all: [{ program: "pnpm" }, { arg0In: ["dlx"] }],
      },
      reason: "remote package execution stays review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.packages.common:review-pnpm-exec-flags",
      effect: "review",
      match: {
        all: [{ program: "pnpm" }, { arg0In: ["exec"] }],
      },
      reason:
        "pnpm exec flags or missing target prevent safe target projection",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.packages.common:allow-pnpm-read-only-info",
      effect: "allow",
      match: PNPM_READ_ONLY_INFO_FAMILY,
      reason: "pnpm read-only package information command",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.packages.common:review-pip-scope-flags",
      effect: "review",
      match: {
        all: [
          { program: "pip" },
          {
            any: [
              { flagPresent: "user" },
              { flagPresent: "target" },
              { flagPresent: "prefix" },
            ],
          },
        ],
      },
      reason: "pip install scope flags require review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.packages.common:review-uv-pip-scope-flags",
      effect: "review",
      match: {
        all: [
          { program: "uv" },
          { arg0In: ["pip"] },
          {
            any: [
              { flagPresent: "system" },
              { flagPresent: "target" },
              { flagPresent: "prefix" },
            ],
          },
        ],
      },
      reason: "uv pip install scope flags require review",
      provenance: { source: "shipped" },
    },
    packageManagerRule(
      "bash.packages.common:allow-npm-common",
      "npm",
      ["install", "ci", "update"],
      "npm common project dependency workflow",
    ),
    packageManagerRule(
      "bash.packages.common:allow-pnpm-common",
      "pnpm",
      ["install", "add", "remove", "update"],
      "pnpm common project dependency workflow",
    ),
    packageManagerRule(
      "bash.packages.common:allow-yarn-common",
      "yarn",
      ["install", "add", "remove", "upgrade"],
      "yarn common project dependency workflow",
    ),
    packageManagerRule(
      "bash.packages.common:allow-cargo-common",
      "cargo",
      ["add", "update", "remove"],
      "cargo common project dependency workflow",
    ),
    packageManagerRule(
      "bash.packages.common:allow-uv-common",
      "uv",
      ["sync", "add", "remove"],
      "uv common project dependency workflow",
    ),
    {
      id: "bash.packages.common:allow-uv-pip-install",
      effect: "allow",
      match: {
        all: [
          { program: "uv" },
          { arg0In: ["pip"] },
          { argAt: { index: 1, value: "install" } },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "uv pip install project dependency workflow",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.packages.common:allow-uv-pip-sync",
      effect: "allow",
      match: {
        all: [
          { program: "uv" },
          { arg0In: ["pip"] },
          { argAt: { index: 1, value: "sync" } },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "uv pip sync project dependency workflow",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.packages.common:allow-pip-install",
      effect: "allow",
      match: {
        all: [
          { program: "pip" },
          { arg0In: ["install"] },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "pip install project dependency workflow",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.packages.common:allow-go-mod-tidy",
      effect: "allow",
      match: {
        all: [
          { program: "go" },
          { arg0In: ["mod"] },
          { argAt: { index: 1, value: "tidy" } },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "go mod tidy project dependency workflow",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.packages.common:allow-go-mod-download",
      effect: "allow",
      match: {
        all: [
          { program: "go" },
          { arg0In: ["mod"] },
          { argAt: { index: 1, value: "download" } },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "go mod download project dependency workflow",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.packages.common:allow-go-get",
      effect: "allow",
      match: {
        all: [
          { program: "go" },
          { arg0In: ["get"] },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "go get project dependency workflow",
      provenance: { source: "shipped" },
    },
  ],
} as const;

export const bashPackagesCommonPack = defineShippedPack(rawPack);
