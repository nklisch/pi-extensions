/**
 * FFF compatibility search for Pi.
 *
 * Upstream @ff-labs/pi-fff is excellent for fuzzy/smart discovery, but its
 * fffind/ffgrep semantics intentionally differ from Pi's built-in find/grep.
 * This extension exposes the same fast FFF index through a conservative surface:
 * glob-only file lookup and exact regex/literal grep with no fuzzy fallback.
 *
 * Default mode registers fast_find/fast_grep alongside the built-ins. Set
 * PI_FFF_COMPAT_OVERRIDE=1 before Pi starts to register these exact
 * compatibility tools as find/grep instead.
 *
 * Watcher & inotify budget:
 *   FFF maintains a real-time native inotify watcher with one watch per
 *   indexed file. Scanning the home directory (millions of files, mostly
 *   caches) blows past fs.inotify.max_user_watches and leaves the index
 *   silently stale on files it couldn't watch. Two independent knobs:
 *     PI_FFF_COMPAT_HOME_SCAN=1   — opt into home-dir scanning (default off).
 *     PI_FFF_COMPAT_DISABLE_WATCH=1 — scan once, no live watcher at all
 *                                     (index goes stale until rescan).
 *   Also raise fs.inotify.max_user_watches (see /etc/sysctl.d) when enabling
 *   home scanning or working in very large trees.
 */

import { statSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGenerationGuardedFinderLifecycle } from "./finder-lifecycle.js";

const EXTENSION_NAME = "pi-fff-compat";
const PACKAGE_HINT = "bundled dependency of @nklisch/pi-fff-compat";
const OVERRIDE_ENV = "PI_FFF_COMPAT_OVERRIDE";
const DISABLE_ENV = "PI_FFF_COMPAT_DISABLE";
// Home-dir scanning watches every file under ~ (caches, runtimes, browser
// profiles, etc.), which on this machine is ~1.2M files — far beyond the
// kernel inotify budget and almost entirely churn-prone noise. Off by
// default; set PI_FFF_COMPAT_HOME_SCAN=1 to opt in (also raise
// fs.inotify.max_user_watches).
const HOME_SCAN_ENV = "PI_FFF_COMPAT_HOME_SCAN";
// FFF's native watcher already debounces and batches events, but maintaining
// one inotify watch per indexed file is what exhausts the kernel budget. Set
// PI_FFF_COMPAT_DISABLE_WATCH=1 for a one-shot scan with no live tracking —
// the index then goes stale on changes until a manual /fff-compat-rescan.
const DISABLE_WATCH_ENV = "PI_FFF_COMPAT_DISABLE_WATCH";
const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_GREP_LIMIT = 100;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const GREP_MAX_LINE_LENGTH = 500;
const INITIAL_SCAN_WAIT_MS = 15_000;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

type FffFileItem = {
  relativePath: string;
  fileName: string;
};

type FffSearchResult = {
  items: FffFileItem[];
  totalMatched: number;
  totalFiles: number;
};

type FffGrepCursor = unknown;

type FffGrepMatch = {
  relativePath: string;
  fileName: string;
  lineNumber: number;
  col: number;
  lineContent: string;
  contextBefore?: string[];
  contextAfter?: string[];
};

type FffGrepResult = {
  items: FffGrepMatch[];
  totalMatched: number;
  totalFiles: number;
  totalFilesSearched: number;
  filteredFileCount: number;
  nextCursor: FffGrepCursor | null;
  regexFallbackError?: string;
};

type FffScanProgress = {
  scannedFilesCount: number;
  isScanning: boolean;
  isWatcherReady: boolean;
  isWarmupComplete: boolean;
};

type FffHealth = {
  version: string;
  git: { repositoryFound: boolean; workdir?: string };
  filePicker: { initialized: boolean; indexedFiles?: number; basePath?: string };
};

type FffFinder = {
  readonly isDestroyed: boolean;
  destroy(): void;
  glob(pattern: string, options?: { pageIndex?: number; pageSize?: number; maxThreads?: number }): Result<FffSearchResult>;
  grep(
    query: string,
    options?: {
      mode?: "plain" | "regex" | "fuzzy";
      smartCase?: boolean;
      pageSize?: number;
      maxMatchesPerFile?: number;
      beforeContext?: number;
      afterContext?: number;
      cursor?: FffGrepCursor | null;
    },
  ): Result<FffGrepResult>;
  waitForScan(timeoutMs?: number): Promise<Result<boolean>>;
  scanFiles(): Result<void>;
  getScanProgress(): Result<FffScanProgress>;
  healthCheck(testPath?: string): Result<FffHealth>;
};

type FffModule = {
  FileFinder: {
    create(options: Record<string, unknown>): Result<FffFinder>;
  };
};

type FindInput = {
  pattern: string;
  path?: string;
  limit?: number;
};

type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
};

type ToolNames = {
  find: string;
  grep: string;
};

type Truncation = {
  content: string;
  truncated: boolean;
  omittedLines: number;
  omittedBytes: number;
};

let fffModulePromise: Promise<FffModule> | null = null;
let activeCwd = process.cwd();

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWorkspacePath(cwd: string, input: string | undefined, fallback = "."): string {
  const raw = input?.trim() || fallback;
  const absolute = path.resolve(cwd, raw);
  if (!isInsideOrEqual(cwd, absolute)) {
    throw new Error(`Path must stay inside the workspace: ${input}`);
  }
  return absolute;
}

function relativeToWorkspace(cwd: string, absolute: string): string {
  const relative = toPosixPath(path.relative(cwd, absolute));
  return relative === "" ? "." : relative;
}

function loadFffModule(): Promise<FffModule> {
  if (!fffModulePromise) {
    fffModulePromise = (async () => {
      try {
        return (await import("@ff-labs/fff-node")) as unknown as FffModule;
      } catch (error) {
        throw new Error(
          `Failed to load @ff-labs/fff-node (${PACKAGE_HINT}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  }
  return fffModulePromise;
}

const finderLifecycle = createGenerationGuardedFinderLifecycle<FffFinder>(async (cwd) => {
  const { FileFinder } = await loadFffModule();
  const created = FileFinder.create({
    basePath: cwd,
    frecencyDbPath: process.env.FFF_FRECENCY_DB,
    historyDbPath: process.env.FFF_HISTORY_DB,
    aiMode: true,
    enableHomeDirScanning: envFlagEnabled(process.env[HOME_SCAN_ENV]),
    enableFsRootScanning: envFlagEnabled(process.env.FFF_ENABLE_ROOT_SCAN),
    disableWatch: envFlagEnabled(process.env[DISABLE_WATCH_ENV]),
  });
  if (!created.ok) throw new Error(`Failed to create FFF finder: ${created.error}`);

  const candidate = created.value;
  try {
    const scan = await candidate.waitForScan(INITIAL_SCAN_WAIT_MS);
    if (!scan.ok) throw new Error(`FFF scan failed: ${scan.error}`);
    return candidate;
  } catch (error) {
    if (!candidate.isDestroyed) {
      try {
        candidate.destroy();
      } catch {
        // Preserve the scan/create failure; lifecycle cleanup is best effort.
      }
    }
    throw error;
  }
});

function ensureFinder(cwd: string): Promise<FffFinder> {
  return finderLifecycle.ensure(cwd);
}

function truncateLine(line: string): { text: string; wasTruncated: boolean } {
  const sanitized = line.replace(/\r/g, "").replace(/\n$/, "");
  if (sanitized.length <= GREP_MAX_LINE_LENGTH) return { text: sanitized, wasTruncated: false };
  return { text: `${sanitized.slice(0, GREP_MAX_LINE_LENGTH)}...`, wasTruncated: true };
}

function truncateOutput(text: string): Truncation {
  const lines = text.split("\n");
  const lineLimited = lines.length > MAX_OUTPUT_LINES;
  const byLines = lineLimited ? lines.slice(0, MAX_OUTPUT_LINES).join("\n") : text;

  const buffer = Buffer.from(byLines, "utf8");
  const byteLimited = buffer.length > MAX_OUTPUT_BYTES;
  const content = byteLimited ? buffer.subarray(0, MAX_OUTPUT_BYTES).toString("utf8").replace(/\uFFFD$/, "") : byLines;

  return {
    content,
    truncated: lineLimited || byteLimited,
    omittedLines: lineLimited ? lines.length - MAX_OUTPUT_LINES : 0,
    omittedBytes: byteLimited ? buffer.length - MAX_OUTPUT_BYTES : 0,
  };
}

function appendNotices(output: string, notices: string[]): string {
  return notices.length > 0 ? `${output}\n\n[${notices.join(". ")}]` : output;
}

function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined ? Math.max(1, Math.floor(value)) : fallback;
}

function fdStyleGlob(pattern: string): string {
  const trimmed = toPosixPath(pattern.trim());
  if (!trimmed) return "**/*";
  if (trimmed === "**" || trimmed.startsWith("**/") || trimmed.startsWith("/")) return trimmed;
  // Pi's built-in find uses fd --glob. Bare patterns match basenames anywhere
  // under the search root, and path-containing relative patterns are matched
  // against the full path from any depth. `**/` gives FFF glob the same shape.
  return `**/${trimmed}`;
}

function joinGlobWithSearchRoot(searchRootRel: string, pattern: string): string {
  const normalizedPattern = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  if (searchRootRel === ".") return normalizedPattern;
  return `${stripTrailingSlash(searchRootRel)}/${normalizedPattern}`;
}

function outputPathRelativeToSearchRoot(cwd: string, searchRootAbs: string, fffRelativePath: string): string {
  const searchRootRel = relativeToWorkspace(cwd, searchRootAbs);
  if (searchRootRel === ".") return fffRelativePath;

  const prefix = `${stripTrailingSlash(searchRootRel)}/`;
  if (fffRelativePath.startsWith(prefix)) return fffRelativePath.slice(prefix.length);
  if (fffRelativePath === stripTrailingSlash(searchRootRel)) return path.basename(fffRelativePath);
  return toPosixPath(path.relative(searchRootAbs, path.join(cwd, fffRelativePath)));
}

function grepPathConstraint(cwd: string, absolutePath: string): { constraint: string | null; isDirectory: boolean } {
  let stat;
  try {
    stat = statSync(absolutePath);
  } catch {
    throw new Error(`Path not found: ${absolutePath}`);
  }

  const relative = relativeToWorkspace(cwd, absolutePath);
  const isDirectory = stat.isDirectory();
  if (relative === ".") return { constraint: null, isDirectory };
  return { constraint: isDirectory ? `${stripTrailingSlash(relative)}/` : relative, isDirectory };
}

function buildGrepQuery(cwd: string, input: GrepInput, searchPathAbs: string, searchPattern: string): string {
  const parts: string[] = [];
  const pathConstraint = grepPathConstraint(cwd, searchPathAbs).constraint;
  if (pathConstraint) parts.push(pathConstraint);
  if (input.glob?.trim()) parts.push(input.glob.trim());
  parts.push(searchPattern);
  return parts.join(" ");
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function grepModeAndPattern(input: GrepInput): { mode: "plain" | "regex"; pattern: string } {
  if (!input.ignoreCase) {
    return input.literal === true ? { mode: "plain", pattern: input.pattern } : { mode: "regex", pattern: input.pattern };
  }

  const inner = input.literal === true ? escapeRegexLiteral(input.pattern) : input.pattern;
  return { mode: "regex", pattern: `(?i:${inner})` };
}

function formatGrepPath(cwd: string, searchPathAbs: string, searchPathIsDirectory: boolean, fffRelativePath: string): string {
  if (!searchPathIsDirectory) return path.basename(searchPathAbs);
  return outputPathRelativeToSearchRoot(cwd, searchPathAbs, fffRelativePath);
}

function formatGrepMatches(cwd: string, searchPathAbs: string, searchPathIsDirectory: boolean, matches: FffGrepMatch[], contextLines: number): { output: string; linesTruncated: boolean } {
  let linesTruncated = false;
  const outputLines: string[] = [];
  const sorted = [...matches].sort((a, b) => {
    const byPath = a.relativePath.localeCompare(b.relativePath);
    if (byPath !== 0) return byPath;
    const byLine = a.lineNumber - b.lineNumber;
    if (byLine !== 0) return byLine;
    return a.col - b.col;
  });

  for (const match of sorted) {
    const displayPath = formatGrepPath(cwd, searchPathAbs, searchPathIsDirectory, match.relativePath);
    if (contextLines > 0) {
      const before = match.contextBefore ?? [];
      before.forEach((line, index) => {
        const lineNumber = match.lineNumber - before.length + index;
        const truncated = truncateLine(line);
        if (truncated.wasTruncated) linesTruncated = true;
        outputLines.push(`${displayPath}-${lineNumber}- ${truncated.text}`);
      });
    }

    const matchLine = truncateLine(match.lineContent);
    if (matchLine.wasTruncated) linesTruncated = true;
    outputLines.push(`${displayPath}:${match.lineNumber}: ${matchLine.text}`);

    if (contextLines > 0) {
      const after = match.contextAfter ?? [];
      after.forEach((line, index) => {
        const lineNumber = match.lineNumber + index + 1;
        const truncated = truncateLine(line);
        if (truncated.wasTruncated) linesTruncated = true;
        outputLines.push(`${displayPath}-${lineNumber}- ${truncated.text}`);
      });
    }
  }

  return { output: outputLines.join("\n"), linesTruncated };
}

function toolNames(): ToolNames {
  return envFlagEnabled(process.env[OVERRIDE_ENV]) ? { find: "find", grep: "grep" } : { find: "fast_find", grep: "fast_grep" };
}

function usageHint(names: ToolNames, overriding: boolean): string {
  const toolLabel = overriding ? "the built-in-looking find/grep tools" : `${names.find}/${names.grep}`;
  return [
    "FFF search tools are available in this session; choose the exact or fuzzy surface intentionally.",
    `Use ${toolLabel} for fast, deterministic search when you want normal Pi find/grep semantics backed by the FFF index.`,
    `Use ${names.find} for glob-only file searches. It returns paths relative to the requested search directory and is the fast replacement for ordinary find-style glob lookup.`,
    `Use ${names.grep} for exact content search. It is regex by default, literal only when literal=true, honors ignoreCase, and intentionally has no fuzzy fallback.`,
    "Use fffind for fuzzy/conceptual file discovery: vague file names, feature names, path fragments, typo-tolerant lookup, and git/frecency-ranked exploration. Do not treat it as an exhaustive deterministic glob result.",
    "Use ffgrep for fuzzy/smart content discovery: broad identifiers, likely related terms, fast exploratory lookup, and frecency-ranked matches. It may fuzzy-fallback when exact matches fail, so prefer the compatibility grep for exact verification.",
    `Prefer workspace-relative paths with ${names.find}/${names.grep}; the compatibility layer rejects paths outside the workspace because the FFF index is workspace-scoped.`,
  ].join("\n");
}

const findSchema = Type.Object({
  pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
  path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: `Maximum number of results (default ${DEFAULT_FIND_LIMIT})` })),
});

function reportInitializationFailure(ctx: ExtensionContext, error: unknown): void {
  let detail = "unknown failure";
  try { detail = error instanceof Error ? error.message : String(error); }
  catch { detail = "unreadable failure"; }
  const message = `${EXTENSION_NAME} init failed: ${detail}`;
  try {
    ctx.ui.notify(message, "error");
  } catch {
    // Initialization can settle after session replacement. The old UI is then
    // intentionally stale, so fall back to a process diagnostic without
    // allowing either reporting sink to escape the awaited host boundary.
    try { console.error(message); } catch { /* no safe reporting sink remains */ }
  }
}

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search in (default: current directory)" })),
  glob: Type.Optional(Type.String({ description: "Include/exclude glob for files, passed with ripgrep-style semantics" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string instead of regex" })),
  context: Type.Optional(Type.Number({ description: "Context lines before and after each match" })),
  limit: Type.Optional(Type.Number({ description: `Maximum number of matching lines (default ${DEFAULT_GREP_LIMIT})` })),
});

export default function fffCompatSearch(pi: ExtensionAPI) {
  if (envFlagEnabled(process.env[DISABLE_ENV])) return;

  const names = toolNames();
  const overriding = names.find === "find" || names.grep === "grep";
  const injectedUsageHint = usageHint(names, overriding);

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${injectedUsageHint}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    activeCwd = ctx.cwd;
    if (overriding) {
      ctx.ui.notify(`${EXTENSION_NAME}: overriding built-in find/grep with deterministic FFF-backed tools`, "warning");
    }
    if (envFlagEnabled(process.env[HOME_SCAN_ENV])) {
      ctx.ui.notify(
        `${EXTENSION_NAME}: home-dir scanning is ON (PI_FFF_COMPAT_HOME_SCAN=1). Ensure fs.inotify.max_user_watches is large enough or the index will silently go stale.`,
        "warning",
      );
    }
    if (envFlagEnabled(process.env[DISABLE_WATCH_ENV])) {
      ctx.ui.notify(`${EXTENSION_NAME}: live watcher disabled (PI_FFF_COMPAT_DISABLE_WATCH=1); index goes stale until /fff-compat-rescan`, "info");
    }

    try {
      await ensureFinder(activeCwd);
    } catch (error) {
      reportInitializationFailure(ctx, error);
    }
  });

  pi.on("session_shutdown", async () => {
    finderLifecycle.revoke();
  });

  pi.registerTool({
    name: names.find,
    label: names.find,
    description: `Search for files by glob pattern using the FFF index while preserving Pi find semantics. Returns paths relative to the search directory. Respects the indexed/gitignored file set. Output is truncated to ${DEFAULT_FIND_LIMIT} results or ${MAX_OUTPUT_BYTES / 1024}KB.`,
    promptSnippet: "Fast deterministic glob file search backed by FFF",
    promptGuidelines: [
      `Use ${names.find} when you need deterministic glob-style file search with FFF speed; use fffind for fuzzy/conceptual file discovery.`,
    ],
    parameters: findSchema,
    async execute(_toolCallId, params: FindInput, signal, _onUpdate, ctx: ExtensionContext) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const cwd = ctx.cwd || activeCwd;
      const f = await ensureFinder(cwd);
      const searchRootAbs = resolveWorkspacePath(cwd, params.path, ".");
      let stat;
      try {
        stat = statSync(searchRootAbs);
      } catch {
        throw new Error(`Path not found: ${searchRootAbs}`);
      }
      if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${searchRootAbs}`);

      const effectiveLimit = normalizePositiveLimit(params.limit, DEFAULT_FIND_LIMIT);
      const searchRootRel = relativeToWorkspace(cwd, searchRootAbs);
      const fffGlob = joinGlobWithSearchRoot(searchRootRel, fdStyleGlob(params.pattern));
      const result = f.glob(fffGlob, { pageIndex: 0, pageSize: effectiveLimit });
      if (!result.ok) throw new Error(result.error);
      if (signal?.aborted) throw new Error("Operation aborted");

      if (result.value.items.length === 0) {
        return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
      }

      const outputPaths = result.value.items
        .map((item) => outputPathRelativeToSearchRoot(cwd, searchRootAbs, item.relativePath))
        .sort((a, b) => a.localeCompare(b));
      const truncated = truncateOutput(outputPaths.join("\n"));
      const notices: string[] = [];
      const details: Record<string, unknown> = {
        backend: "fff.glob",
        totalMatched: result.value.totalMatched,
        totalFiles: result.value.totalFiles,
        glob: fffGlob,
      };

      if (result.value.totalMatched > result.value.items.length) {
        notices.push(`${effectiveLimit} results limit reached`);
        details.resultLimitReached = effectiveLimit;
      }
      if (truncated.truncated) {
        notices.push(`${MAX_OUTPUT_BYTES / 1024}KB output limit reached`);
        details.truncation = truncated;
      }

      return {
        content: [{ type: "text", text: appendNotices(truncated.content, notices) }],
        details,
      };
    },
  });

  pi.registerTool({
    name: names.grep,
    label: names.grep,
    description: `Search file contents using the FFF index while preserving Pi grep semantics: regex by default, literal only when literal=true, ignoreCase honored, no fuzzy fallback. Returns matching lines with file paths and line numbers. Output is truncated to ${DEFAULT_GREP_LIMIT} matches or ${MAX_OUTPUT_BYTES / 1024}KB.`,
    promptSnippet: "Fast deterministic content search backed by FFF",
    promptGuidelines: [
      `Use ${names.grep} when you need exact grep-style content search with FFF speed; use ffgrep for fuzzy/smart discovery.`,
      `Set literal=true on ${names.grep} for fixed-string searches; regex is the default to match Pi's built-in grep semantics.`,
    ],
    parameters: grepSchema,
    async execute(_toolCallId, params: GrepInput, signal, _onUpdate, ctx: ExtensionContext) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const cwd = ctx.cwd || activeCwd;
      const f = await ensureFinder(cwd);
      const searchPathAbs = resolveWorkspacePath(cwd, params.path, ".");
      const { isDirectory } = grepPathConstraint(cwd, searchPathAbs);
      const effectiveLimit = normalizePositiveLimit(params.limit, DEFAULT_GREP_LIMIT);
      const contextLines = Math.max(0, Math.floor(params.context ?? 0));
      const mode = grepModeAndPattern(params);
      const query = buildGrepQuery(cwd, params, searchPathAbs, mode.pattern);

      const result = f.grep(query, {
        mode: mode.mode,
        smartCase: false,
        pageSize: effectiveLimit,
        maxMatchesPerFile: effectiveLimit,
        beforeContext: contextLines,
        afterContext: contextLines,
      });
      if (!result.ok) throw new Error(result.error);
      if (result.value.regexFallbackError) throw new Error(`Invalid regex: ${result.value.regexFallbackError}`);
      if (signal?.aborted) throw new Error("Operation aborted");

      if (result.value.items.length === 0) {
        return { content: [{ type: "text", text: "No matches found" }], details: undefined };
      }

      const formatted = formatGrepMatches(cwd, searchPathAbs, isDirectory, result.value.items, contextLines);
      const truncated = truncateOutput(formatted.output);
      const notices: string[] = [];
      const details: Record<string, unknown> = {
        backend: "fff.grep",
        mode: mode.mode,
        totalMatched: result.value.totalMatched,
        totalFiles: result.value.totalFiles,
        totalFilesSearched: result.value.totalFilesSearched,
        filteredFileCount: result.value.filteredFileCount,
      };

      if (result.value.nextCursor) {
        notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
        details.matchLimitReached = effectiveLimit;
      }
      if (formatted.linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        details.linesTruncated = true;
      }
      if (truncated.truncated) {
        notices.push(`${MAX_OUTPUT_BYTES / 1024}KB output limit reached`);
        details.truncation = truncated;
      }

      return {
        content: [{ type: "text", text: appendNotices(truncated.content, notices) }],
        details,
      };
    },
  });

  pi.registerCommand("fff-compat", {
    description: "Show FFF compatibility search status",
    handler: async (_args, ctx) => {
      try {
        const f = await ensureFinder(ctx.cwd);
        const health = f.healthCheck();
        if (!health.ok) {
          ctx.ui.notify(`FFF compat health failed: ${health.error}`, "error");
          return;
        }
        const progress = f.getScanProgress();
        const homeScan = envFlagEnabled(process.env[HOME_SCAN_ENV]);
        const watchDisabled = envFlagEnabled(process.env[DISABLE_WATCH_ENV]);
        const lines = [
          `Mode: ${overriding ? "override find/grep" : `${names.find}/${names.grep}`}`,
          `FFF v${health.value.version}`,
          `Base: ${health.value.filePicker.basePath ?? ctx.cwd}`,
          `Indexed: ${health.value.filePicker.indexedFiles ?? "unknown"} files`,
          `Git: ${health.value.git.repositoryFound ? `yes (${health.value.git.workdir ?? "unknown"})` : "no"}`,
          `Home scan: ${homeScan ? "on (PI_FFF_COMPAT_HOME_SCAN=1)" : "off (workspace only)"}`,
          `Watcher: ${watchDisabled ? "disabled (PI_FFF_COMPAT_DISABLE_WATCH=1)" : "enabled"}`,
        ];
        if (progress.ok) {
          lines.push(
            `Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} scanned, warmup ${progress.value.isWarmupComplete ? "done" : "pending"})`,
            `Watcher ready: ${progress.value.isWatcherReady ? "yes" : "no"}`,
          );
        }
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        ctx.ui.notify(`FFF compat unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("fff-compat-rescan", {
    description: "Trigger a rescan for FFF compatibility search",
    handler: async (_args, ctx) => {
      try {
        const f = await ensureFinder(ctx.cwd);
        const result = f.scanFiles();
        if (!result.ok) {
          ctx.ui.notify(`FFF compat rescan failed: ${result.error}`, "error");
          return;
        }
        ctx.ui.notify("FFF compat rescan triggered", "info");
      } catch (error) {
        ctx.ui.notify(`FFF compat rescan unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
