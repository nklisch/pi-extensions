import type { RawMatcher } from "./condition-guards.ts";
import { defineShippedPack } from "./define.ts";

const NETWORK_READ_PROGRAMS = ["curl"] as const;

// wget is deliberately NOT an allow family: it downloads to a local file by
// default, so it is a network fetch + local write, not a read. Only explicit
// stdout forms could ever qualify, and the DSL cannot yet prove flag-value
// shape (`-O -`); all wget forms route to review below.

const NETWORK_READ_HAZARD_FLAGS: Readonly<
  Record<(typeof NETWORK_READ_PROGRAMS)[number], readonly string[]>
> = {
  curl: [
    "d",
    "data",
    "data-raw",
    "data-ascii",
    "data-binary",
    "data-urlencode",
    "json",
    "F",
    "form",
    "form-string",
    "T",
    "upload-file",
    "X",
    "request",
    "u",
    "user",
    "cert",
    "cacert",
    "cookie",
    "cookie-jar",
    "oauth2-bearer",
    "aws-sigv4",
    "proxy-user",
    "H",
    "header",
    "K",
    "config",
    "o",
    "output",
    "output-dir",
    "O",
    "remote-name",
    "remote-name-all",
  ],
};

const NETWORK_READ_HAZARD_SHORT_CHARS: Readonly<
  Record<(typeof NETWORK_READ_PROGRAMS)[number], readonly string[]>
> = {
  // Bundled short flags: `curl -LO` projects as one flag named "LO", so
  // exact-name matching misses it. Any of these chars in a bundle is hazardous.
  curl: ["d", "F", "T", "X", "u", "H", "K", "o", "O"],
};

const networkReadAllowRules = NETWORK_READ_PROGRAMS.map((program) => ({
  id: `bash.network.read:allow-${program}`,
  effect: "allow",
  match: {
    all: [
      { program },
      { noSubstitution: true },
      { noStdoutRedirect: true },
      {
        not: {
          flagMatches: {
            names: NETWORK_READ_HAZARD_FLAGS[program],
            shortChars: NETWORK_READ_HAZARD_SHORT_CHARS[program],
          },
        },
      },
    ],
  },
  reason: `${program} network read without substitution or stdout redirection`,
  provenance: { source: "shipped" },
}));

const rawPack = {
  version: 1,
  id: "bash.network.read",
  rules: [
    {
      id: "bash.network.read:review-curl-mutation-or-upload",
      effect: "review",
      match: {
        all: [
          { program: "curl" },
          {
            any: [
              { flagPresent: "d" },
              { flagPresent: "data" },
              { flagPresent: "data-raw" },
              { flagPresent: "data-ascii" },
              { flagPresent: "data-binary" },
              { flagPresent: "data-urlencode" },
              { flagPresent: "json" },
              { flagPresent: "F" },
              { flagPresent: "form" },
              { flagPresent: "form-string" },
              { flagPresent: "T" },
              { flagPresent: "upload-file" },
              { flagPresent: "X" },
              { flagPresent: "request" },
              { flagMatches: { shortChars: ["d", "F", "T", "X"] } },
            ],
          },
        ],
      },
      reason:
        "curl method override, body, form, or upload flags require review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.network.read:review-curl-credentials",
      effect: "review",
      match: {
        all: [
          { program: "curl" },
          {
            any: [
              { flagPresent: "u" },
              { flagPresent: "user" },
              { flagPresent: "cert" },
              { flagPresent: "cacert" },
              { flagPresent: "cookie" },
              { flagPresent: "cookie-jar" },
              { flagPresent: "oauth2-bearer" },
              { flagPresent: "aws-sigv4" },
              { flagPresent: "proxy-user" },
              { flagPresent: "H" },
              { flagPresent: "header" },
              { flagPresent: "K" },
              { flagPresent: "config" },
              { flagMatches: { shortChars: ["u", "H", "K"] } },
            ],
          },
        ],
      },
      reason: "curl credential-bearing flags require review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.network.read:review-curl-explicit-output-path",
      effect: "review",
      match: {
        all: [
          { program: "curl" },
          {
            any: [
              { flagPresent: "o" },
              { flagPresent: "output" },
              { flagPresent: "output-dir" },
              { flagPresent: "O" },
              { flagPresent: "remote-name" },
              { flagPresent: "remote-name-all" },
              { flagMatches: { shortChars: ["o", "O"] } },
            ],
          },
        ],
      },
      reason: "curl explicit output path requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.network.read:review-wget-mutation-or-body",
      effect: "review",
      match: {
        all: [
          { program: "wget" },
          {
            any: [
              { flagPresent: "post-data" },
              { flagPresent: "post-file" },
              { flagPresent: "method" },
              { flagPresent: "body-data" },
              { flagPresent: "body-file" },
            ],
          },
        ],
      },
      reason: "wget POST/method/body flags require review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.network.read:review-wget-credentials",
      effect: "review",
      match: {
        all: [
          { program: "wget" },
          {
            any: [
              { flagPresent: "user" },
              { flagPresent: "password" },
              { flagPresent: "proxy-user" },
              { flagPresent: "proxy-password" },
            ],
          },
        ],
      },
      reason: "wget credential-bearing flags require review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.network.read:review-wget-explicit-output-path",
      effect: "review",
      match: {
        all: [
          { program: "wget" },
          {
            any: [
              { flagPresent: "O" },
              { flagPresent: "output-document" },
              { flagPresent: "P" },
              { flagPresent: "directory-prefix" },
            ],
          },
        ],
      },
      reason: "wget explicit output path requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.network.read:review-wget-download",
      effect: "review",
      match: { program: "wget" },
      reason:
        "wget downloads to a local file by default; it is a network fetch plus local write, not a read-only command",
      provenance: { source: "shipped" },
    },
    ...networkReadAllowRules,
  ],
} as const;

/** Network read stage families are intentionally opt-in to composition v1. */
export const BASH_NETWORK_READ_STAGE_FAMILY_MATCHERS: readonly RawMatcher[] =
  rawPack.rules
    .filter((rule) => rule.effect === "allow")
    .map((rule) => rule.match as RawMatcher);

export const bashNetworkReadPack = defineShippedPack(rawPack);
