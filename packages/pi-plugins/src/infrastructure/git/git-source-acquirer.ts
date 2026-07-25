import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MarketplaceSourceSchema,
  PluginSourceSchema,
  createResolvedMarketplaceSource,
  createResolvedPluginSource,
  type MarketplaceSource,
  type PluginSource,
  type ResolvedMarketplaceSource,
  type ResolvedPluginSource,
  type Sha256,
} from "../../domain/source.js";
import { normalizeContentPath } from "../../domain/content-manifest.js";
import { SourceMaterializationError } from "../../application/source-materialization.js";
import {
  DEFAULT_MATERIALIZATION_LIMITS,
  type GitSourceAcquirer,
  type MaterializationLimits,
  type SecureContentSession,
} from "../../application/ports/source-acquisition.js";
import type { TarReader } from "../archive/tar-reader.js";
import type { CommandResult, CommandRunner } from "../../application/ports/process-runner.js";
import type { CommandCapturePolicy } from "../../application/ports/process-runner.js";
import type {
  ApprovedNetworkTarget,
  NetworkEgressPolicy,
} from "../network/network-egress-policy.js";

const SELECTED_REF = "refs/materialization/selected";
const FULL_SHA = /^[0-9a-f]{40}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

type GitFailureKind = "adapter" | "resolution";
type EffectiveLimits = MaterializationLimits;

type GitSourceAcquirerOptions = Readonly<{
  gitExecutable?: string;
  command: CommandRunner;
  archive: TarReader;
  sha256: Sha256;
  egress: NetworkEgressPolicy;
  limits?: Partial<MaterializationLimits>;
}>;

type RemoteSource = Readonly<{
  url: string;
  local: boolean;
}>;

type RemoteRef = Readonly<{
  name: string;
  object: string;
}>;

class GitCommandFailure extends Error {
  readonly exitCode: number;
  readonly stderr: Uint8Array;

  constructor(exitCode: number, stderr: Uint8Array) {
    super("Git command returned a failure status");
    this.name = "GitCommandFailure";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

function effectiveLimits(input?: Partial<MaterializationLimits>): EffectiveLimits {
  const value = { ...DEFAULT_MATERIALIZATION_LIMITS, ...(input ?? {}) };
  for (const [name, limit] of Object.entries(value)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError(`materialization limit ${name} must be positive`);
  }
  if (value.maxExpansionRatio < 1) throw new TypeError("maxExpansionRatio must be at least one");
  return Object.freeze(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function safeFailure(
  code: "PATH_CONTAINMENT_FAILED" | "SOURCE_RESOLUTION_FAILED" | "ADAPTER_FAILED",
  classification: "security" | "permanent" | "transient",
  operation: string,
  message: string,
  cause?: unknown,
): SourceMaterializationError {
  return new SourceMaterializationError({
    code,
    classification,
    operation,
    message,
    details: { operation },
    cause,
  });
}

function invalidSource(operation: string, cause?: unknown): SourceMaterializationError {
  return safeFailure(
    "SOURCE_RESOLUTION_FAILED",
    "permanent",
    operation,
    "Git source declaration is invalid",
    cause instanceof SourceMaterializationError ? cause : undefined,
  );
}

function decode(bytes: Uint8Array, operation: string): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw safeFailure("ADAPTER_FAILED", "permanent", operation, "Git returned non-UTF-8 output", error);
  }
}

function outputBytes(result: CommandResult, operation: string): Uint8Array {
  if (result.stdout instanceof Uint8Array) return result.stdout;
  throw safeFailure("ADAPTER_FAILED", "permanent", operation, "Git output mode was not captured");
}

async function* outputChunks(result: CommandResult, operation: string): AsyncIterable<Uint8Array> {
  if (result.stdout instanceof Uint8Array) {
    if (result.stdout.byteLength > 0) yield result.stdout;
    return;
  }
  for await (const chunk of result.stdout) {
    if (!(chunk instanceof Uint8Array)) throw safeFailure("ADAPTER_FAILED", "permanent", operation, "Git archive yielded non-byte output");
    if (chunk.byteLength > 0) yield chunk;
  }
}

function isTransient(stderr: Uint8Array): boolean {
  const text = new TextDecoder("utf-8").decode(stderr).toLowerCase();
  return [
    "could not resolve host",
    "name or service not known",
    "temporary failure",
    "connection timed out",
    "connection reset",
    "network is unreachable",
    "early eof",
    "remote end hung up",
    "timed out",
    "http 408",
    "http 429",
    "http 500",
    "http 502",
    "http 503",
    "http 504",
    " 408 ",
    " 429 ",
    " 500 ",
    " 502 ",
    " 503 ",
    " 504 ",
  ].some((marker) => text.includes(marker));
}

function classifyGitFailure(
  operation: string,
  failure: GitCommandFailure,
): SourceMaterializationError {
  return safeFailure(
    "SOURCE_RESOLUTION_FAILED",
    isTransient(failure.stderr) ? "transient" : "permanent",
    operation,
    isTransient(failure.stderr) ? "Git remote is temporarily unavailable" : "Git source could not be resolved",
    // Do not attach stderr. It can contain URLs, usernames, helper output, or
    // server-controlled secrets; only the owning redacted logger may inspect it.
  );
}

async function runCommand(
  command: CommandRunner,
  executable: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>>,
  stdout: "capture" | "stream",
  maxCapturedBytes: number,
  operation: string,
  failureKind: GitFailureKind,
): Promise<CommandResult> {
  throwIfAborted(signal);
  let result: CommandResult;
  try {
    const capture: CommandCapturePolicy = {
      stdout: { mode: stdout, maxBytes: maxCapturedBytes, overflow: "error" },
      stderr: { maxBytes: 64 * 1024, overflow: "truncate" },
    };
    result = await command.run({
      executable,
      args,
      cwd,
      environment: { inherit: "host", values: env },
      capture,
    }, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (error instanceof SourceMaterializationError) throw error;
    throw safeFailure("ADAPTER_FAILED", "permanent", operation, "Git process adapter failed", error);
  }
  if (result.completion !== undefined) return result;
  if (result.exitCode !== 0) {
    if (failureKind === "adapter") {
      throw safeFailure("ADAPTER_FAILED", "permanent", operation, "Git adapter command failed");
    }
    throw classifyGitFailure(operation, new GitCommandFailure(result.exitCode, result.stderr));
  }
  return result;
}

function parseRemoteRefs(bytes: Uint8Array, operation: string): RemoteRef[] {
  const text = decode(bytes, operation);
  const result: RemoteRef[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.length === 0 || trimmed.startsWith("ref: ")) continue;
    const separator = trimmed.indexOf("\t");
    if (separator <= 0) continue;
    const object = trimmed.slice(0, separator).toLowerCase();
    const name = trimmed.slice(separator + 1);
    if (!FULL_SHA.test(object) || name.length === 0) continue;
    result.push({ name, object });
  }
  return result;
}

function parseNulRecords(bytes: Uint8Array, operation: string): string[] {
  const text = decode(bytes, operation);
  if (text.length === 0) return [];
  return text.split("\0").filter((value) => value.length > 0);
}

function validateSubdirectory(path: string): string {
  try {
    return normalizeContentPath(path);
  } catch (error) {
    throw safeFailure("PATH_CONTAINMENT_FAILED", "security", "archiveGitSource", "Git subdirectory is not a safe relative path", error);
  }
}

function remoteForMarketplace(source: MarketplaceSource): RemoteSource {
  switch (source.kind) {
    case "github":
      return { url: `https://github.com/${source.repository}.git`, local: false };
    case "git":
      return { url: source.url, local: false };
    case "local-git":
      return { url: source.path, local: true };
  }
}

function remoteForPlugin(source: Extract<PluginSource, { kind: "git" | "git-subdir" }>): RemoteSource {
  return { url: source.url, local: false };
}

function sshCommand(target: ApprovedNetworkTarget): string {
  const options = [
    "ssh",
    "-o BatchMode=yes",
    `-o HostName=${target.address}`,
    `-o HostKeyAlias=${target.hostname}`,
    `-o Port=${target.port}`,
    "-o ForwardAgent=no",
    "-o ProxyCommand=none",
    "-o ProxyJump=none",
  ];
  if (!target.credentialsApproved) {
    options.push("-F none", "-o IdentitiesOnly=yes", "-o IdentityAgent=none", "-o IdentityFile=none");
  }
  return options.join(" ");
}

function gitEnvironment(target?: ApprovedNetworkTarget): Readonly<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  if (target?.protocol === "ssh:") values.GIT_SSH_COMMAND = sshCommand(target);
  if (target !== undefined && !target.credentialsApproved) {
    values.GIT_CONFIG_NOSYSTEM = "1";
    values.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
    values.GIT_ASKPASS = undefined;
    values.SSH_ASKPASS = undefined;
    values.SSH_ASKPASS_REQUIRE = "never";
    values.SSH_AUTH_SOCK = undefined;
    values.SSH_AGENT_PID = undefined;
  }
  if (target !== undefined) {
    // Git proxy configuration can resolve or redirect the destination outside
    // the pinned target. Acquisition therefore never inherits ambient proxies.
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      values[name] = undefined;
    }
  }
  return values;
}

function networkConfig(target?: ApprovedNetworkTarget): readonly string[] {
  if (target === undefined) return [];
  const config = ["-c", "http.followRedirects=false", "-c", "remote.origin.proxy=", "-c", "core.gitProxy="];
  if (target.protocol === "https:") {
    const address = target.family === 6 ? `[${target.address}]` : target.address;
    const originUrl = `${target.url.protocol}//${target.url.host}/`;
    config.push(
      "-c", `http.${originUrl}.followRedirects=false`,
      "-c", `http.${originUrl}.proxy=`,
      // curloptResolve is list-valued; clear inherited approved-origin entries
      // before adding the one address authorized for this acquisition.
      "-c", "http.curloptResolve=",
      "-c", `http.curloptResolve=${target.hostname}:${target.port}:${address}`,
    );
    if (!target.credentialsApproved) config.push("-c", "credential.helper=", "-c", "http.extraHeader=");
    config.push("-c", "http.proxy=");
  }
  return config;
}

async function prepareLocalSource(source: RemoteSource): Promise<RemoteSource> {
  if (!source.local) return source;
  let path: string;
  try {
    const declared = await lstat(source.url);
    if (declared.isSymbolicLink() || !declared.isDirectory()) throw new Error("local Git source is not a real directory");
    path = await realpath(source.url);
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("local Git source is not a real directory");
  } catch (error) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "local Git source is unavailable", error);
  }
  return { url: path, local: true };
}

async function runCapture(
  command: CommandRunner,
  executable: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>>,
  maxCapturedBytes: number,
  operation: string,
  failureKind: GitFailureKind,
): Promise<Uint8Array> {
  const result = await runCommand(command, executable, args, cwd, signal, env, "capture", maxCapturedBytes, operation, failureKind);
  return outputBytes(result, operation);
}

async function initializeScratch(
  options: GitSourceAcquirerOptions,
  scratch: string,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await runCommand(
    options.command,
    options.gitExecutable ?? "git",
    ["init", "--bare", "--quiet", "."],
    scratch,
    signal,
    env,
    "capture",
    64 * 1024,
    "resolveGitSource",
    "adapter",
  );
}

async function addRemote(
  options: GitSourceAcquirerOptions,
  scratch: string,
  source: RemoteSource,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await runCommand(
    options.command,
    options.gitExecutable ?? "git",
    ["remote", "add", "origin", source.url],
    scratch,
    signal,
    env,
    "capture",
    64 * 1024,
    "resolveGitSource",
    "adapter",
  );
}

async function verifyEffectiveRemote(
  options: GitSourceAcquirerOptions,
  scratch: string,
  source: RemoteSource,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const output = decode(await runCapture(
    options.command,
    options.gitExecutable ?? "git",
    ["remote", "get-url", "--all", "origin"],
    scratch,
    signal,
    env,
    64 * 1024,
    "resolveGitSource",
    "adapter",
  ), "resolveGitSource");
  const remotes = output.split(/\r?\n/u).filter((value) => value.length > 0);
  // `remote get-url` applies url.*.insteadOf. Requiring the exact approved
  // declaration prevents a user/foreign config rewrite from silently changing
  // the host that subsequent Git commands contact.
  if (remotes.length !== 1 || remotes[0] !== source.url) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "security", "resolveGitSource", "Git effective remote differs from the approved source");
  }
}

async function queryRemote(
  options: GitSourceAcquirerOptions,
  scratch: string,
  args: readonly string[],
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>>,
  target: ApprovedNetworkTarget | undefined,
  operation: string,
): Promise<RemoteRef[]> {
  const output = await runCapture(
    options.command,
    options.gitExecutable ?? "git",
    [...networkConfig(target), "ls-remote", ...args],
    scratch,
    signal,
    env,
    1024 * 1024,
    operation,
    "resolution",
  );
  return parseRemoteRefs(output, operation);
}

async function fetchRef(
  options: GitSourceAcquirerOptions,
  scratch: string,
  remoteRef: string,
  expectedObject: string,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>>,
  target: ApprovedNetworkTarget | undefined,
): Promise<string> {
  await runCommand(
    options.command,
    options.gitExecutable ?? "git",
    [...networkConfig(target), "fetch", "--no-tags", "--no-recurse-submodules", "--force", "origin", `+${remoteRef}:${SELECTED_REF}`],
    scratch,
    signal,
    env,
    "capture",
    1024 * 1024,
    "resolveGitSource",
    "resolution",
  );
  const actual = decode(await runCapture(
    options.command,
    options.gitExecutable ?? "git",
    ["rev-parse", "--verify", "--end-of-options", SELECTED_REF],
    scratch,
    signal,
    env,
    1024 * 1024,
    "resolveGitSource",
    "resolution",
  ), "resolveGitSource").trim().toLowerCase();
  if (!FULL_SHA.test(actual) || actual !== expectedObject) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "Git ref changed while it was being acquired");
  }
  return await peelCommit(options, scratch, SELECTED_REF, signal, env);
}

async function fetchSha(
  options: GitSourceAcquirerOptions,
  scratch: string,
  sha: string,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>>,
  target: ApprovedNetworkTarget | undefined,
): Promise<string> {
  await runCommand(
    options.command,
    options.gitExecutable ?? "git",
    [...networkConfig(target), "fetch", "--no-tags", "--no-recurse-submodules", "--force", "origin", sha],
    scratch,
    signal,
    env,
    "capture",
    1024 * 1024,
    "resolveGitSource",
    "resolution",
  );
  const type = decode(await runCapture(
    options.command,
    options.gitExecutable ?? "git",
    ["cat-file", "-t", "--", sha],
    scratch,
    signal,
    env,
    1024 * 1024,
    "resolveGitSource",
    "resolution",
  ), "resolveGitSource").trim();
  if (type !== "commit") {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "Git SHA does not identify a commit");
  }
  const verified = decode(await runCapture(
    options.command,
    options.gitExecutable ?? "git",
    ["rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`],
    scratch,
    signal,
    env,
    1024 * 1024,
    "resolveGitSource",
    "resolution",
  ), "resolveGitSource").trim().toLowerCase();
  if (verified !== sha) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "Git SHA verification failed");
  }
  return verified;
}

async function peelCommit(
  options: GitSourceAcquirerOptions,
  scratch: string,
  object: string,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const commit = decode(await runCapture(
    options.command,
    options.gitExecutable ?? "git",
    ["rev-parse", "--verify", "--end-of-options", `${object}^{commit}`],
    scratch,
    signal,
    env,
    1024 * 1024,
    "resolveGitSource",
    "resolution",
  ), "resolveGitSource").trim().toLowerCase();
  if (!FULL_SHA.test(commit)) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "Git ref does not peel to a commit");
  }
  return commit;
}

async function resolveRevision(
  options: GitSourceAcquirerOptions,
  scratch: string,
  ref: string | undefined,
  sha: string | undefined,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>>,
  target: ApprovedNetworkTarget | undefined,
): Promise<string> {
  if (sha !== undefined) return fetchSha(options, scratch, sha, signal, env, target);

  if (ref !== undefined && FULL_SHA.test(ref)) {
    return fetchSha(options, scratch, ref, signal, env, target);
  }

  if (ref === undefined) {
    const refs = await queryRemote(options, scratch, ["--symref", "origin", "HEAD"], signal, env, target, "resolveGitSource");
    const head = refs.find((entry) => entry.name === "HEAD");
    if (head === undefined) throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "Git remote HEAD is unavailable");
    return fetchRef(options, scratch, "HEAD", head.object, signal, env, target);
  }

  if (ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/")) {
    const refs = await queryRemote(options, scratch, ["--refs", "origin", ref], signal, env, target, "resolveGitSource");
    const match = refs.find((entry) => entry.name === ref);
    if (match === undefined) throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "Git ref is missing");
    return fetchRef(options, scratch, match.name, match.object, signal, env, target);
  }

  const branchName = `refs/heads/${ref}`;
  const tagName = `refs/tags/${ref}`;
  const refs = await queryRemote(options, scratch, ["--refs", "origin", branchName, tagName], signal, env, target, "resolveGitSource");
  const matches = refs.filter((entry) => entry.name === branchName || entry.name === tagName);
  if (matches.length === 0) throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "Git ref is missing");
  if (matches.length > 1) throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "Git ref is ambiguous between a branch and tag");
  const match = matches[0];
  if (match === undefined) throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "Git ref is missing");
  return fetchRef(options, scratch, match.name, match.object, signal, env, target);
}

function treePathFromRecord(record: string): Readonly<{ mode: string; path: string }> | undefined {
  const tab = record.indexOf("\t");
  if (tab < 0) return undefined;
  const header = record.slice(0, tab).split(" ");
  const mode = header[0];
  const path = record.slice(tab + 1);
  if (mode === undefined || path.length === 0) return undefined;
  return { mode, path };
}

async function inspectTree(
  options: GitSourceAcquirerOptions,
  scratch: string,
  revision: string,
  subdirectory: string | undefined,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>>,
  limits: EffectiveLimits,
): Promise<void> {
  const args = ["ls-tree", "--full-tree", "-r", "-z", revision];
  if (subdirectory !== undefined) args.push("--", `:(top,literal)${subdirectory}`);
  const records = parseNulRecords(await runCapture(
    options.command,
    options.gitExecutable ?? "git",
    args,
    scratch,
    signal,
    env,
    limits.maxArchiveBytes,
    "resolveGitSource",
    "resolution",
  ), "resolveGitSource");
  for (const record of records) {
    const entry = treePathFromRecord(record);
    if (entry === undefined) continue;
    const relativePath = subdirectory === undefined
      ? entry.path
      : entry.path === subdirectory
        ? ""
        : entry.path.startsWith(`${subdirectory}/`)
          ? entry.path.slice(subdirectory.length + 1)
          : entry.path;
    if (entry.mode === "160000") {
      throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "Git submodules are unsupported");
    }
    if (relativePath.split("/").some((segment) => segment === ".gitmodules")) {
      throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "Git sources containing submodules are unsupported");
    }
  }
}

async function ensureSubdirectory(
  options: GitSourceAcquirerOptions,
  scratch: string,
  revision: string,
  path: string,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const literal = `:(top,literal)${path}`;
  const treeRecords = parseNulRecords(await runCapture(
    options.command,
    options.gitExecutable ?? "git",
    ["ls-tree", "--full-tree", "-d", "-z", "--name-only", revision, "--", literal],
    scratch,
    signal,
    env,
    1024 * 1024,
    "resolveGitSource",
    "resolution",
  ), "resolveGitSource");
  if (!treeRecords.includes(path)) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "Git subdirectory is missing");
  }
  const files = parseNulRecords(await runCapture(
    options.command,
    options.gitExecutable ?? "git",
    ["ls-tree", "--full-tree", "-r", "-z", "--name-only", revision, "--", literal],
    scratch,
    signal,
    env,
    1024 * 1024,
    "resolveGitSource",
    "resolution",
  ), "resolveGitSource");
  if (!files.some((entry) => entry.startsWith(`${path}/`))) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "resolveGitSource", "Git subdirectory is empty");
  }
}

async function archiveTree(
  options: GitSourceAcquirerOptions,
  scratch: string,
  revision: string,
  subdirectory: string | undefined,
  sink: SecureContentSession,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>>,
  limits: EffectiveLimits,
): Promise<void> {
  const args = ["--git-dir=.", "archive", "--format=tar", revision];
  if (subdirectory !== undefined) args.push("--", `:(top,literal)${subdirectory}`);
  const result = await runCommand(
    options.command,
    options.gitExecutable ?? "git",
    args,
    scratch,
    signal,
    env,
    "stream",
    limits.maxArchiveBytes,
    "archiveGitSource",
    "resolution",
  );
  let archiveFailure: unknown;
  try {
    await options.archive.read(
      outputChunks(result, "archiveGitSource"),
      sink,
      signal,
      {
        limits,
        ...(subdirectory === undefined ? {} : { stripPrefix: subdirectory }),
      },
    );
  } catch (error) {
    archiveFailure = error;
  }
  let processFailure: unknown;
  try {
    if (result.completion !== undefined) {
      const exitCode = await result.completion;
      if (exitCode !== 0) throw new Error("Git archive command failed");
    } else if (result.exitCode !== 0) throw new Error("Git archive command failed");
  } catch (error) {
    processFailure = error;
  }
  if (signal.aborted) throw signal.reason ?? archiveFailure ?? processFailure;
  if (archiveFailure !== undefined && processFailure !== undefined) {
    throw safeFailure("ADAPTER_FAILED", "permanent", "archiveGitSource", "Git archive and stream processing both failed", new AggregateError([archiveFailure, processFailure]));
  }
  if (archiveFailure !== undefined) {
    if (archiveFailure instanceof SourceMaterializationError) throw archiveFailure;
    throw safeFailure("ADAPTER_FAILED", "permanent", "archiveGitSource", "Git archive adapter failed", archiveFailure);
  }
  if (processFailure !== undefined) {
    throw safeFailure("SOURCE_RESOLUTION_FAILED", "permanent", "archiveGitSource", "Git archive command failed", processFailure);
  }
}

async function cleanupScratch(scratch: string): Promise<void> {
  await rm(scratch, { recursive: true, force: true });
}

async function withScratch<T>(
  signal: AbortSignal,
  workRoot: string,
  work: (scratch: string) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  if (typeof workRoot !== "string" || workRoot.length === 0) {
    throw safeFailure("ADAPTER_FAILED", "permanent", "resolveGitSource", "content session does not expose private scratch work");
  }
  let scratch: string;
  try {
    scratch = await mkdtemp(join(workRoot, "git-"));
  } catch (error) {
    throw safeFailure("ADAPTER_FAILED", "permanent", "resolveGitSource", "failed to create Git scratch data", error);
  }
  let value: T | undefined;
  let failure: unknown;
  try {
    value = await work(scratch);
  } catch (error) {
    failure = error;
  }
  let cleanupFailure: unknown;
  try {
    await cleanupScratch(scratch);
  } catch (error) {
    cleanupFailure = error;
  }
  if (failure !== undefined && cleanupFailure !== undefined) {
    throw safeFailure(
      "ADAPTER_FAILED",
      "permanent",
      "abortMaterialization",
      "Git acquisition and scratch cleanup both failed",
      new AggregateError([failure, cleanupFailure], "Git acquisition cleanup failed"),
    );
  }
  if (cleanupFailure !== undefined) {
    throw safeFailure("ADAPTER_FAILED", "permanent", "abortMaterialization", "failed to remove Git scratch data", cleanupFailure);
  }
  if (failure !== undefined) {
    if (signal.aborted) throw signal.reason ?? failure;
    throw failure;
  }
  return value as T;
}

function createMarketplaceResult(
  source: MarketplaceSource,
  revision: string,
  sha256: Sha256,
): ResolvedMarketplaceSource {
  try {
    return createResolvedMarketplaceSource({ declared: source, revision }, sha256);
  } catch (error) {
    throw safeFailure("ADAPTER_FAILED", "permanent", "resolveGitSource", "resolved marketplace source contract could not be constructed", error);
  }
}

function createPluginResult(
  source: Extract<PluginSource, { kind: "git" | "git-subdir" }>,
  revision: string,
  sha256: Sha256,
): ResolvedPluginSource {
  try {
    return source.kind === "git"
      ? createResolvedPluginSource({ kind: "git", url: source.url, revision }, sha256)
      : createResolvedPluginSource({ kind: "git-subdir", url: source.url, path: source.path, revision }, sha256);
  } catch (error) {
    throw safeFailure("ADAPTER_FAILED", "permanent", "resolveGitSource", "resolved plugin source contract could not be constructed", error);
  }
}

async function acquire(
  options: GitSourceAcquirerOptions,
  source: MarketplaceSource | Extract<PluginSource, { kind: "git" | "git-subdir" }>,
  subdirectory: string | undefined,
  sha: string | undefined,
  ref: string | undefined,
  sink: SecureContentSession,
  signal: AbortSignal,
  marketplace: boolean,
): Promise<ResolvedMarketplaceSource | ResolvedPluginSource> {
  const limits = effectiveLimits(options.limits);
  const remote = await prepareLocalSource(
    marketplace
      ? remoteForMarketplace(source as MarketplaceSource)
      : remoteForPlugin(source as Extract<PluginSource, { kind: "git" | "git-subdir" }>),
  );
  let target: ApprovedNetworkTarget | undefined;
  if (!remote.local) {
    try {
      const protocol = remote.url.startsWith("https:") ? "https:" : "ssh:";
      target = await options.egress.authorize(remote.url, protocol);
    } catch (error) {
      const resolution = error !== null && typeof error === "object" && "kind" in error && error.kind === "resolution";
      throw safeFailure(
        "SOURCE_RESOLUTION_FAILED",
        resolution ? "transient" : "security",
        "resolveGitSource",
        resolution ? "Git destination could not be resolved" : "Git destination is not permitted",
      );
    }
  }
  const env = gitEnvironment(target);
  const normalizedSubdirectory = subdirectory === undefined ? undefined : validateSubdirectory(subdirectory);
  return withScratch(signal, sink.workRoot ?? "", async (scratch) => {
    await initializeScratch(options, scratch, signal, env);
    await addRemote(options, scratch, remote, signal, env);
    await verifyEffectiveRemote(options, scratch, remote, signal, env);
    const revision = await resolveRevision(options, scratch, ref, sha, signal, env, target);
    if (normalizedSubdirectory !== undefined) await ensureSubdirectory(options, scratch, revision, normalizedSubdirectory, signal, env);
    await inspectTree(options, scratch, revision, normalizedSubdirectory, signal, env, limits);
    await archiveTree(options, scratch, revision, normalizedSubdirectory, sink, signal, env, limits);
    return marketplace
      ? createMarketplaceResult(source as MarketplaceSource, revision, options.sha256)
      : createPluginResult(source as Extract<PluginSource, { kind: "git" | "git-subdir" }>, revision, options.sha256);
  });
}

export function createGitSourceAcquirer(options: GitSourceAcquirerOptions): GitSourceAcquirer {
  if (options === null || typeof options !== "object") throw new TypeError("Git source acquirer options are required");
  if (typeof options.command?.run !== "function") throw new TypeError("Git source acquirer requires a command runner");
  if (typeof options.archive?.read !== "function") throw new TypeError("Git source acquirer requires a tar reader");
  if (typeof options.sha256 !== "function") throw new TypeError("Git source acquirer requires SHA-256");
  if (options.egress === null || typeof options.egress?.authorize !== "function") throw new TypeError("Git source acquirer requires an egress policy");
  const sha256 = options.sha256;

  return {
    async materializeMarketplace(input, sink, signal) {
      let source: MarketplaceSource;
      try {
        source = MarketplaceSourceSchema.parse(input);
      } catch (error) {
        throw invalidSource("resolveGitSource", error);
      }
      return await acquire(options, source, undefined, undefined, source.ref, sink, signal, true) as ResolvedMarketplaceSource;
    },

    async materializePlugin(input, sink, signal) {
      let source: Extract<PluginSource, { kind: "git" | "git-subdir" }>;
      try {
        const parsed = PluginSourceSchema.parse(input);
        if (parsed.kind !== "git" && parsed.kind !== "git-subdir") throw new Error("not a Git plugin source");
        source = parsed;
      } catch (error) {
        throw invalidSource("resolveGitSource", error);
      }
      const subdirectory = source.kind === "git-subdir" ? source.path : undefined;
      return await acquire(options, source, subdirectory, source.sha, source.ref, sink, signal, false) as ResolvedPluginSource;
    },
  };
}

export type { GitSourceAcquirerOptions };
