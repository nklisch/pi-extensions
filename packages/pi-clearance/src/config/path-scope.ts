import path from "node:path";

/** Pure lexical path helpers shared by config normalization and validation. */
export function normalizeAbsolutePath(value: string): string {
  return path.resolve(value);
}

export function isPathWithinOrEqual(
  candidate: string,
  directory: string,
): boolean {
  const relative = path.relative(directory, candidate);
  return !(relative.startsWith("..") || path.isAbsolute(relative));
}

export function isPathWithinAnyOf(
  candidate: string,
  directories: readonly string[],
): boolean {
  return directories.some((directory) =>
    isPathWithinOrEqual(candidate, directory),
  );
}

export const DEFAULT_AGENT_SUPPORT_HOME_DIRECTORIES = [
  [".pi", "agent", "skills"],
  [".pi", "agent", "plugins"],
  [".pi", "agent", "extensions"],
  [".pi", "agent", "docs"],
  [".pi", "agent", "rules"],
  [".pi", "agent", "npm", "node_modules"],
  [".pi", "agent", "plugin-host", "stores"],
] as const;

export function defaultAgentSupportDirectories(
  homeDirectory: string,
): readonly string[] {
  const home = normalizeAbsolutePath(homeDirectory);
  return DEFAULT_AGENT_SUPPORT_HOME_DIRECTORIES.map((segments) =>
    path.join(home, ...segments),
  );
}

const SENSITIVE_HOME_DIRECTORIES = [
  [".ssh"],
  [".gnupg"],
  [".config", "gnupg"],
  [".aws"],
  [".config", "systemd"],
  [".config", "keyring"],
  [".password-store"],
  [".docker"],
  [".kube"],
  [".config", "gcloud"],
  [".azure"],
] as const;
const SENSITIVE_HOME_FILE_PATHS = [
  [".pi", "agent", "auth.json"],
  [".pi", "agent", "models.json"],
  [".config", "gh", "hosts.yml"],
  [".config", "gh", "hosts.yaml"],
  [".config", "glab", "hosts.yml"],
  [".config", "glab", "hosts.yaml"],
  [".config", "glab-cli", "hosts.yml"],
  [".config", "glab-cli", "hosts.yaml"],
  [".cargo", "credentials.toml"],
] as const;
const SENSITIVE_HOME_FILE_NAMES = [
  ".netrc",
  ".env",
  ".npmrc",
  ".pypirc",
] as const;
const SENSITIVE_HOME_DOT_FILE_NAMES = [
  "access_token",
  "access_token.json",
  "access_tokens",
  "access_tokens.db",
  "access_tokens.json",
  "accessTokens.json",
  "api-key",
  "api-key.json",
  "api_key",
  "api_key.json",
  "apikey",
  "apikey.json",
  "auth",
  "auth.json",
  "auth.yml",
  "auth.yaml",
  "credential",
  "credential.yml",
  "credential.yaml",
  "credentials",
  "credentials.db",
  "credentials.json",
  "credentials.toml",
  "credentials.yml",
  "credentials.yaml",
  "oauth.json",
  "oauth_tokens.json",
  "refresh_token",
  "refresh_token.json",
  "refresh_tokens",
  "refresh_tokens.json",
  "secret",
  "secrets",
  "secrets.json",
  "token",
  "token.db",
  "token.json",
  "tokens",
  "tokens.db",
  "tokens.json",
] as const;

export function isSensitiveHomePath(
  absolutePath: string,
  homeDirectory: string | undefined,
): boolean {
  try {
    if (homeDirectory === undefined || homeDirectory.trim().length === 0)
      return false;
    const normalizedPath = normalizeAbsoluteInput(absolutePath);
    const normalizedHome = normalizeAbsoluteInput(homeDirectory);
    if (normalizedPath === undefined || normalizedHome === undefined)
      return false;
    if (!isPathWithinOrEqual(normalizedPath, normalizedHome)) return false;
    const relative = path.relative(normalizedHome, normalizedPath);
    if (relative.length === 0) return false;
    const segments = relative
      .split(path.sep)
      .filter((segment) => segment.length > 0);
    const basename = segments.at(-1) ?? "";
    return (
      SENSITIVE_HOME_DIRECTORIES.some((directory) =>
        startsWith(segments, directory),
      ) ||
      SENSITIVE_HOME_FILE_PATHS.some((filePath) =>
        equalSegments(segments, filePath),
      ) ||
      SENSITIVE_HOME_FILE_NAMES.some((fileName) => basename === fileName) ||
      basename.startsWith(".env.") ||
      (segments.length >= 2 &&
        (segments[0] ?? "").startsWith(".") &&
        (SENSITIVE_HOME_DOT_FILE_NAMES.some((name) => basename === name) ||
          keyMaterial(basename)))
    );
  } catch {
    return false;
  }
}

export function dedupePaths(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return paths.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function normalizeAbsoluteInput(value: string): string | undefined {
  if (value.trim().length === 0) return undefined;
  const platformPath = value.replace(/[\\/]+/gu, path.sep);
  return path.isAbsolute(platformPath)
    ? normalizeAbsolutePath(platformPath)
    : undefined;
}
function startsWith(
  segments: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    segments.length >= prefix.length &&
    prefix.every((segment, index) => segments[index] === segment)
  );
}
function equalSegments(
  segments: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    segments.length === expected.length &&
    expected.every((segment, index) => segments[index] === segment)
  );
}
function keyMaterial(name: string): boolean {
  return (
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    name === "id_rsa" ||
    name.startsWith("id_") ||
    name.endsWith("_rsa") ||
    name.endsWith("_ed25519") ||
    name.endsWith(".p12") ||
    name.endsWith(".pfx")
  );
}
