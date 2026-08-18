import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const scratch = mkdtempSync(join(tmpdir(), "pi-enhanced-subagent-restart-"));
const packOut = join(scratch, "pack");
const extracted = join(scratch, "extracted");
const sessionDir = join(scratch, "sessions");
const inspector = join(scratch, "inspect-tools.mjs");
const sessionId = "019d9a5f-7b13-7000-8000-000000000001";
const requiredTools = ["subagent", "get_subagent_result", "steer_subagent"];
const liveChildren = new Set();

function stageRuntimeDependency(candidateRoot, name) {
  const target = resolve(repoRoot, "node_modules", name);
  const destination = join(candidateRoot, "node_modules", name);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(target, destination, { recursive: true });
}

function startPi(extensionPath, extraArgs = []) {
  const cli = resolve(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const child = spawn(process.execPath, [
    cli,
    "--offline",
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--extension", extensionPath,
    "--extension", inspector,
    "--mode", "rpc",
    "--session-dir", sessionDir,
    "--session-id", sessionId,
    ...extraArgs,
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  liveChildren.add(child);
  let stdout = "";
  let stderr = "";
  let sequence = 0;
  const pending = new Map();
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.on("data", chunk => {
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { continue; }
      if (event.type !== "response" || typeof event.id !== "string") continue;
      const waiter = pending.get(event.id);
      if (!waiter) continue;
      pending.delete(event.id);
      waiter.resolve(event);
    }
  });
  const exited = new Promise(resolvePromise => {
    child.once("exit", (code, signal) => {
      liveChildren.delete(child);
      const error = new Error(`Pi exited before responding (${code ?? signal})\n${stderr}`);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      resolvePromise({ code, signal });
    });
  });

  async function request(command) {
    const id = `restart-${++sequence}`;
    const response = new Promise((resolvePromise, reject) => {
      pending.set(id, { resolve: resolvePromise, reject });
    });
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    const timer = setTimeout(() => {
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      waiter.reject(new Error(`Pi RPC timed out for ${command.type}\n${stderr}`));
    }, 20_000);
    timer.unref?.();
    try {
      const result = await response;
      if (!result.success) throw new Error(`Pi RPC ${command.type} failed: ${result.error ?? "unknown error"}\n${stderr}`);
      return result;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }

  return { child, exited, request, stderr: () => stderr };
}

async function inspect(runtime) {
  await runtime.request({ type: "get_commands" });
  await runtime.request({ type: "prompt", message: "/inspect-tools" });
  const entries = await runtime.request({ type: "get_entries" });
  const report = entries.data.entries.findLast(
    entry => entry.type === "custom" && entry.customType === "subagent-tool-regression",
  )?.data;
  if (!report) throw new Error(`Inspector produced no report\n${runtime.stderr()}`);
  for (const name of requiredTools) {
    if (!report.registered.includes(name) || !report.active.includes(name)) {
      throw new Error(`Missing active subagent tool ${name}: ${JSON.stringify(report)}\n${runtime.stderr()}`);
    }
  }
}

try {
  mkdirSync(packOut, { recursive: true });
  mkdirSync(extracted, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const raw = execFileSync(
    process.execPath,
    [resolve(repoRoot, "scripts/pack-package.mjs"), packageRoot, "--out", packOut],
    { encoding: "utf8" },
  );
  const report = JSON.parse(raw);
  const tarball = join(packOut, report[0].filename);
  execFileSync("tar", ["-xzf", tarball, "-C", extracted]);
  const candidate = join(extracted, "package");

  // A normal npm installation provides these ordinary dependencies beside the
  // bundled packages. Keep Pi's peer packages absent from this tree: the test
  // specifically exercises the bridge from an externally installed Pi host.
  stageRuntimeDependency(candidate, "jiti");
  stageRuntimeDependency(candidate, "@sinclair/typebox");

  writeFileSync(inspector, `
export default function (pi) {
  pi.registerCommand("inspect-tools", {
    description: "Inspect subagent tool registration",
    handler: async () => {
      pi.appendEntry("subagent-tool-regression", {
        registered: pi.getAllTools().map(tool => tool.name),
        active: pi.getActiveTools(),
      });
    },
  });
}
`);

  const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
  const extensionPath = resolve(candidate, manifest.pi.extensions.find(path => path.includes("production-subagents-extension")));

  const first = startPi(extensionPath);
  await inspect(first);
  first.child.kill("SIGKILL");
  await first.exited;

  const resumed = startPi(extensionPath);
  await inspect(resumed);
  resumed.child.stdin.end();
  const exit = await resumed.exited;
  if (exit.code !== 0) throw new Error(`Resumed Pi exited unsuccessfully: ${JSON.stringify(exit)}\n${resumed.stderr()}`);

  console.log("Subagent tools remain registered and active after abrupt Pi process replacement.");
} finally {
  const children = [...liveChildren];
  const exits = children.map(child => new Promise(resolvePromise => child.once("exit", resolvePromise)));
  for (const child of children) child.kill("SIGKILL");
  await Promise.allSettled(exits);
  rmSync(scratch, { recursive: true, force: true });
}
