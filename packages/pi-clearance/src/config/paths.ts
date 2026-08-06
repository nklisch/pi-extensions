import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

export interface ConfigPaths {
  readonly userConfigRoot: string;
  readonly globalConfigFile: string;
  readonly projectDir: string;
  readonly projectOverlayFile: string;
  readonly repoPolicyFile: string;
  readonly projectKey: string;
}

export function resolveUserConfigRoot(): string {
  // Read the environment explicitly so isolated callers honor the process
  // environment even when os.homedir() is cached.
  const home = firstNonEmpty(
    process.env.HOME,
    process.env.USERPROFILE,
  ) ?? homedir();

  switch (process.platform) {
    case "win32":
      return path.join(
        firstNonEmpty(process.env.LOCALAPPDATA) ??
          path.join(home, "AppData", "Local"),
        "pi",
        "pi-clearance",
      );
    case "darwin":
      return path.join(
        home,
        "Library",
        "Application Support",
        "pi",
        "pi-clearance",
      );
    default:
      return path.join(
        firstNonEmpty(process.env.XDG_CONFIG_HOME) ??
          path.join(home, ".config"),
        "pi",
        "pi-clearance",
      );
  }
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}

export function projectKeyFor(cwd: string): string {
  const absolute = path.resolve(cwd);
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 8);
  const sanitized = path.basename(absolute).replace(/[^a-zA-Z0-9_-]/g, "_");

  return `${sanitized}-${hash}`;
}

export function resolveConfigPaths(cwd: string): ConfigPaths {
  const userConfigRoot = resolveUserConfigRoot();
  const projectKey = projectKeyFor(cwd);
  const projectDir = path.join(userConfigRoot, "projects", projectKey);

  return {
    userConfigRoot,
    globalConfigFile: path.join(userConfigRoot, "global.json"),
    projectDir,
    projectOverlayFile: path.join(projectDir, "overlay.json"),
    repoPolicyFile: path.join(cwd, ".pi-clearance", "policy.json"),
    projectKey,
  };
}
