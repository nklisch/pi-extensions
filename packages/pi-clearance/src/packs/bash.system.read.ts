import type { RawMatcher } from "./condition-guards.ts";
import { defineShippedPack } from "./define.ts";

const READ_SYSTEMCTL_ACTIONS = [
  "status",
  "is-active",
  "is-enabled",
  "is-failed",
  "list-units",
  "list-unit-files",
  "list-timers",
  "list-jobs",
  "list-sockets",
  "list-dependencies",
  "cat",
  "show",
] as const;

const remoteSystemctlFlags = () => ({
  names: ["H", "host", "M", "machine", "root", "image"],
  shortChars: ["H", "M"],
});

const systemctlSafety = (): readonly RawMatcher[] => [
  { not: { flagMatches: remoteSystemctlFlags() } },
  { noSubstitution: true },
  { noStdoutRedirect: true },
];

const journalctlMatcher: RawMatcher = {
  all: [
    { program: "journalctl" },
    {
      not: {
        flagMatches: {
          names: ["rotate", "flush", "update-catalog", "setup-keys"],
          prefixes: ["vacuum-"],
        },
      },
    },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const systemctlActionMatcher: RawMatcher = {
  all: [
    { program: "systemctl" },
    { arg0In: [...READ_SYSTEMCTL_ACTIONS] },
    ...systemctlSafety(),
  ],
};

const systemctlListingMatcher: RawMatcher = {
  all: [
    { program: "systemctl" },
    { argCount: { max: 0 } },
    ...systemctlSafety(),
  ],
};

const containerReadSubcommands = [
  "ps",
  "images",
  "inspect",
  "info",
  "version",
  "history",
  "top",
  "diff",
] as const;

const containerReadMatchers: readonly RawMatcher[] = [
  ...["docker", "podman"].map<RawMatcher>((program) => ({
    all: [
      { program },
      { arg0In: [...containerReadSubcommands] },
      { noSubstitution: true },
      { noStdoutRedirect: true },
    ],
  })),
  ...["docker", "podman"].map<RawMatcher>((program) => ({
    all: [
      { program },
      { arg0In: ["logs"] },
      {
        not: { flagMatches: { names: ["f", "follow"], shortChars: ["f"] } },
      },
      { noSubstitution: true },
      { noStdoutRedirect: true },
    ],
  })),
  ...["docker", "podman"].map<RawMatcher>((program) => ({
    all: [
      { program },
      { arg0In: ["stats"] },
      { flagPresent: "no-stream" },
      { noSubstitution: true },
      { noStdoutRedirect: true },
    ],
  })),
];

const rawPack = {
  version: 1,
  id: "bash.system.read",
  rules: [
    {
      id: "bash.system.read:review-journalctl-mutation",
      effect: "review",
      match: {
        all: [
          { program: "journalctl" },
          {
            flagMatches: {
              names: ["rotate", "flush", "update-catalog", "setup-keys"],
              prefixes: ["vacuum-"],
            },
          },
        ],
      },
      reason: "journalctl rotation, flush, or vacuum mutation requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.system.read:allow-journalctl",
      effect: "allow",
      match: journalctlMatcher,
      reason: "read-only journal inspection without mutation flags",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.system.read:review-systemctl-action",
      effect: "review",
      match: systemctlActionMatcher,
      reason: "systemd service inspection remains review-gated",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.system.read:review-systemctl-listing",
      effect: "review",
      match: systemctlListingMatcher,
      reason: "systemd unit listing remains review-gated",
      provenance: { source: "shipped" },
    },
    ...containerReadMatchers.map((match, index) => ({
      id: `bash.system.read:allow-container-read-${index + 1}`,
      effect: "allow",
      match,
      reason: "read-only container inspection",
      provenance: { source: "shipped" },
    })),
    {
      id: "bash.system.read:review-container-log-follow",
      effect: "review",
      match: {
        all: [
          { any: [{ program: "docker" }, { program: "podman" }] },
          { arg0In: ["logs"] },
          { flagMatches: { names: ["f", "follow"], shortChars: ["f"] } },
        ],
      },
      reason: "container log follow mode is a long-running watcher",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.system.read:review-container-stats-stream",
      effect: "review",
      match: {
        all: [
          { any: [{ program: "docker" }, { program: "podman" }] },
          { arg0In: ["stats"] },
          { not: { flagPresent: "no-stream" } },
        ],
      },
      reason: "container stats streaming is a long-running watcher",
      provenance: { source: "shipped" },
    },
  ],
} as const;

export const BASH_SYSTEM_READ_STAGE_FAMILY_MATCHERS: readonly RawMatcher[] = [
  journalctlMatcher,
  ...containerReadMatchers,
];

export const bashSystemReadPack = defineShippedPack(rawPack);
