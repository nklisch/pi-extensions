import path from "node:path";

import { describe, expect, it } from "vitest";

import { classifyMutationTrustBoundary } from "../../src/parse/native-mutation.ts";
import type { PathFactProjectScope } from "../../src/parse/native-path-facts.ts";
import {
  MUTATION_TRUST_BOUNDARY_KINDS,
  type MutationTrustBoundaryKind,
} from "../../src/parse/shape.ts";

const PROJECT_ROOT = "/home/user/proj";
const HOME = "/home/user";

const PROJECT_SCOPE: PathFactProjectScope = {
  roots: [PROJECT_ROOT],
  writableDirectories: [PROJECT_ROOT],
  tempDirectories: ["/tmp"],
  deniedDirectories: [path.join(PROJECT_ROOT, "secrets")],
  safeHomeDirectories: [],
  unknownPathBehavior: "review",
};

function classify(absolutePath: string | undefined) {
  return classifyMutationTrustBoundary(absolutePath, {
    projectScope: PROJECT_SCOPE,
    homeDirectory: HOME,
  });
}

function inProject(...segments: readonly string[]): string {
  return path.join(PROJECT_ROOT, ...segments);
}

function expectKind(
  absolutePath: string | undefined,
  kind: MutationTrustBoundaryKind,
): void {
  expect(classify(absolutePath).kind).toBe(kind);
}

describe("classifyMutationTrustBoundary", () => {
  it("fails closed to unknown when no concrete path is available", () => {
    expect(classify(undefined)).toEqual({
      kind: "unknown",
      matchedPattern: "missing-path",
    });
  });

  it("classifies home-scope Pi config as user-owned config", () => {
    expectKind(
      path.join(HOME, ".config", "pi", "settings.json"),
      "user-owned-config",
    );
    expectKind(path.join(HOME, ".pi", "trust.json"), "user-owned-config");
  });

  it.each([
    path.join(HOME, ".ssh", "config"),
    path.join(HOME, ".ssh", "id_rsa"),
    path.join(HOME, ".aws", "credentials"),
    path.join(HOME, ".gnupg", "secring.gpg"),
    path.join(HOME, ".config", "gnupg", "foo"),
    path.join(HOME, ".config", "systemd", "user", "x.service"),
    path.join(HOME, ".config", "keyring", "x"),
    path.join(HOME, ".password-store", "foo.gpg"),
    path.join(HOME, ".docker", "config.json"),
    path.join(HOME, ".kube", "config"),
    path.join(HOME, ".netrc"),
    path.join(HOME, ".env"),
    path.join(HOME, ".env.local"),
    path.join(HOME, ".some-dotdir", "foo.pem"),
    path.join(HOME, ".some-dotdir", "id_ed25519"),
  ])("classifies non-project sensitive home path %s", (sensitivePath) => {
    expect(classify(sensitivePath)).toEqual({
      kind: "sensitive-home",
      matchedPattern: "sensitive-home",
    });
  });

  it("classifies sensitive home paths before existing tail patterns", () => {
    expectKind(
      path.join(HOME, ".ssh", "packs", "local.json"),
      "sensitive-home",
    );
    expectKind(path.join(HOME, ".docker", "trust.json"), "sensitive-home");
    expectKind(path.join(HOME, ".kube", "package.json"), "sensitive-home");
  });

  it.each([
    path.join(HOME, "dev", "foo.ts"),
    path.join(HOME, "repos", "x", "README.md"),
    path.join(HOME, "random.txt"),
  ])("classifies non-sensitive home path %s as none", (ordinaryHomePath) => {
    expectKind(ordinaryHomePath, "none");
  });

  it("does not classify project-local sensitive-looking files under home as sensitive-home", () => {
    expectKind(inProject(".env"), "none");
    expectKind(inProject(".env.local"), "none");
    expectKind(inProject(".some-dotdir", "id_ed25519"), "none");
  });

  it("preserves existing precedence for non-sensitive home paths", () => {
    expectKind(path.join(HOME, "other", "packs", "local.json"), "policy-pack");
    expectKind(path.join(HOME, "other", "reviewer.json"), "reviewer-config");
    expectKind(path.join(HOME, ".pi", "trust.json"), "user-owned-config");
  });

  it("classifies policy pack files before broad project overlays", () => {
    expectKind(inProject("packs", "local.json"), "policy-pack");
    expectKind(inProject("packs", "local.ts"), "policy-pack");
    expectKind(inProject(".pi", "packs", "x.json"), "policy-pack");
  });

  it("classifies reviewer config and prompt surfaces", () => {
    expectKind(inProject("config", "reviewer.json"), "reviewer-config");
    expectKind(inProject("config", "reviewer-policy.yaml"), "reviewer-config");
    expectKind(
      inProject("config", "reviewer-prompts.append.md"),
      "reviewer-config",
    );
  });

  it("classifies executable hook and extension surfaces", () => {
    expectKind(inProject("hooks", "pre-commit"), "executable-hook");
    expectKind(inProject(".hooks", "pre-commit"), "executable-hook");
    expectKind(inProject("extensions", "policy.ts"), "executable-hook");
  });

  it("classifies package script surfaces", () => {
    expectKind(inProject("package.json"), "package-script");
    expectKind(inProject("pnpm-workspace.yaml"), "package-script");
  });

  it("classifies project overlays", () => {
    expectKind(inProject("AGENTS.md"), "project-overlay");
    expectKind(inProject("CLAUDE.md"), "project-overlay");
    expectKind(inProject("pi.config.json"), "project-overlay");
    expectKind(inProject("pi.config.yaml"), "project-overlay");
    expectKind(inProject(".pi", "settings.json"), "project-overlay");
    expectKind(inProject(".claude", "settings.json"), "project-overlay");
    expectKind(inProject(".agents", "rules", "local.md"), "project-overlay");
  });

  it.each([
    inProject("src", "foo.ts"),
    inProject("test", "x.test.ts"),
    inProject("docs", "X.md"),
    inProject(".work", "active", "stories", "x.md"),
    inProject("README.md"),
  ])("classifies ordinary path %s as none", (ordinaryPath) => {
    expectKind(ordinaryPath, "none");
  });

  it("normalizes repeated slashes, dot segments, parent segments, and alternate separators", () => {
    expectKind(
      `${PROJECT_ROOT}//.pi\\packs\\.\\nested\\..\\x.json`,
      "policy-pack",
    );
    expectKind(`${PROJECT_ROOT}/src/../AGENTS.md`, "project-overlay");
  });

  it("never throws on adversarial odd strings", () => {
    const knownKinds = new Set<string>(MUTATION_TRUST_BOUNDARY_KINDS);

    for (const oddPath of ["", "\0", "::::", "C:\\tmp\\..\\AGENTS.md"]) {
      expect(() => classify(oddPath)).not.toThrow();
      expect(knownKinds.has(classify(oddPath).kind)).toBe(true);
    }
  });
});
