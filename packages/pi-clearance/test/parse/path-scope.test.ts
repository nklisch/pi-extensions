import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultAgentSupportDirectories,
  isSensitiveHomePath,
} from "../../src/config/path-scope.ts";

const HOME = "/home/user";

function inHome(...segments: readonly string[]): string {
  return path.join(HOME, ...segments);
}

describe("defaultAgentSupportDirectories", () => {
  it("keeps built-in support roots narrow and below the Pi agent directory", () => {
    expect(defaultAgentSupportDirectories(HOME)).toEqual([
      inHome(".pi", "agent", "skills"),
      inHome(".pi", "agent", "plugins"),
      inHome(".pi", "agent", "extensions"),
      inHome(".pi", "agent", "docs"),
      inHome(".pi", "agent", "rules"),
      inHome(".pi", "agent", "npm", "node_modules"),
      inHome(".pi", "agent", "plugin-host", "stores"),
    ]);
  });
});

describe("isSensitiveHomePath", () => {
  it.each([
    inHome(".ssh"),
    inHome(".ssh", "config"),
    inHome(".ssh", "id_rsa"),
    inHome(".gnupg"),
    inHome(".gnupg", "secring.gpg"),
    inHome(".config", "gnupg", "foo"),
    inHome(".aws", "credentials"),
    inHome(".config", "systemd", "user", "x.service"),
    inHome(".config", "keyring", "x"),
    inHome(".password-store", "foo.gpg"),
    inHome(".docker", "config.json"),
    inHome(".kube", "config"),
    inHome(".config", "gcloud"),
    inHome(".config", "gcloud", "credentials.db"),
    inHome(".azure"),
    inHome(".azure", "accessTokens.json"),
  ])("classifies named sensitive home directory path %s", (sensitivePath) => {
    expect(isSensitiveHomePath(sensitivePath, HOME)).toBe(true);
  });

  it.each([
    inHome(".pi", "agent", "auth.json"),
    inHome(".pi", "agent", "models.json"),
    inHome(".config", "gh", "hosts.yml"),
    inHome(".config", "gh", "hosts.yaml"),
    inHome(".config", "glab", "hosts.yml"),
    inHome(".config", "glab-cli", "hosts.yml"),
    inHome(".cargo", "credentials.toml"),
  ])("classifies credential-bearing catalog path %s", (sensitivePath) => {
    expect(isSensitiveHomePath(sensitivePath, HOME)).toBe(true);
  });

  it.each([
    inHome(".netrc"),
    inHome(".env"),
    inHome(".env.local"),
    inHome(".env.production"),
    inHome(".npmrc"),
    inHome(".pypirc"),
    inHome("dev", "service", ".env"),
    inHome("repos", "app", ".env.local"),
  ])("classifies sensitive home dotfile name %s", (sensitivePath) => {
    expect(isSensitiveHomePath(sensitivePath, HOME)).toBe(true);
  });

  it.each([
    inHome(".some-dotdir", "foo.pem"),
    inHome(".some-dotdir", "foo.key"),
    inHome(".some-dotdir", "id_rsa"),
    inHome(".some-dotdir", "id_ed25519"),
    inHome(".some-dotdir", "deploy_rsa"),
    inHome(".some-dotdir", "deploy_ed25519"),
    inHome(".some-dotdir", "cert.p12"),
    inHome(".some-dotdir", "cert.pfx"),
    inHome(".config", "tool", "nested", "id_ecdsa"),
  ])("classifies key material under a home dotdir %s", (sensitivePath) => {
    expect(isSensitiveHomePath(sensitivePath, HOME)).toBe(true);
  });

  it.each([
    inHome(".config", "provider", "token"),
    inHome(".config", "provider", "credentials.json"),
    inHome(".config", "provider", "access_tokens.db"),
    inHome(".config", "provider", "api_key.json"),
    inHome(".config", "provider", "secrets.json"),
  ])("classifies generic credential basename under a home dotdir %s", (sensitivePath) => {
    expect(isSensitiveHomePath(sensitivePath, HOME)).toBe(true);
  });

  it.each([
    inHome("dev", "foo.ts"),
    inHome("repos", "x", "README.md"),
    inHome("random.txt"),
    inHome(".ssh-not", "config"),
    inHome(".config", "systemd-not", "x.service"),
    inHome("dev", "foo.pem"),
    inHome(".some.pem"),
    inHome(".some-dotdir", "notes.txt"),
    inHome(".config", "gh", "config.yml"),
    inHome(".config", "glab-cli", "config.yml"),
    inHome(".cargo", "config.toml"),
    inHome(".config", "provider", "session.json"),
    inHome(".config", "provider", "tokenizer.json"),
    inHome(".pi", "agent", "settings.json"),
    inHome(".pi", "agent", "trust.json"),
    inHome(".pi", "agent", "sessions", "2026-01-01.session.jsonl"),
    inHome(".pi", "agent", "audit", "decisions.jsonl"),
    inHome(".pi", "agent", "cache", "context.json"),
  ])("does not classify non-sensitive home path %s", (candidatePath) => {
    expect(isSensitiveHomePath(candidatePath, HOME)).toBe(false);
  });

  it("returns false when home is missing, empty, or the path is outside home", () => {
    expect(isSensitiveHomePath(inHome(".ssh", "config"), undefined)).toBe(
      false,
    );
    expect(isSensitiveHomePath(inHome(".ssh", "config"), "")).toBe(false);
    expect(isSensitiveHomePath("/etc/ssh/ssh_config", HOME)).toBe(false);
    expect(isSensitiveHomePath("/home/user2/.ssh/config", HOME)).toBe(false);
  });

  it("normalizes lexical dot segments, repeated separators, and mixed separators", () => {
    expect(isSensitiveHomePath(`${HOME}//dev/../.ssh\\config`, HOME)).toBe(
      true,
    );
    expect(isSensitiveHomePath(`${HOME}/../user2/.ssh/config`, HOME)).toBe(
      false,
    );
  });

  it("never throws on adversarial input", () => {
    for (const candidatePath of [
      "",
      "..",
      "../..",
      "\0",
      "::::",
      "C:\\tmp\\id_rsa",
    ]) {
      expect(() => isSensitiveHomePath(candidatePath, HOME)).not.toThrow();
      expect(isSensitiveHomePath(candidatePath, HOME)).toBe(false);
    }
  });
});
