import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "pi-plugin-host-real-pi-"));

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`);
  return result;
}

function timeoutAfter(ms, label) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
}

async function prepareMarketplace(path) {
  const plugin = join(path, "plugins", "demo");
  await mkdir(join(path, ".claude-plugin"), { recursive: true });
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  await mkdir(join(plugin, "skills", "demo"), { recursive: true });
  await writeFile(join(path, ".claude-plugin", "marketplace.json"), JSON.stringify({
    name: "acceptance-market",
    owner: { name: "acceptance" },
    plugins: [{
      name: "demo",
      source: "./plugins/demo",
      description: "Packed real-Pi acceptance plugin",
      category: "testing",
      tags: ["acceptance"],
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    }],
  }, null, 2));
  await writeFile(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({
    name: "demo",
    description: "Packed real-Pi acceptance plugin",
    version: "1.0.0",
    author: { name: "acceptance" },
    license: "MIT",
    skills: ["./skills/demo"],
  }, null, 2));
  await writeFile(join(plugin, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Real Pi manager packed acceptance skill.\n---\n\n# Demo\n\nUse only for packed acceptance.\n");
  checked("git", ["init", "-q"], { cwd: path });
  checked("git", ["config", "user.email", "acceptance@example.invalid"], { cwd: path });
  checked("git", ["config", "user.name", "Acceptance"], { cwd: path });
  checked("git", ["add", "."], { cwd: path });
  checked("git", ["commit", "-qm", "acceptance marketplace"], { cwd: path });
}

async function startRpc({ cli, args, cwd, env }) {
  const child = spawn(process.execPath, [cli, ...args, "--mode", "rpc", "--no-session"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let buffer = "";
  let sequence = 0;
  const events = [];
  const pending = new Map();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffer += chunk;
    while (true) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      let event;
      try { event = JSON.parse(line); }
      catch (error) { throw new Error(`real Pi RPC emitted non-JSON stdout: ${JSON.stringify(line)}\n${error}`); }
      events.push(event);
      if (event.type === "response" && typeof event.id === "string") {
        const waiter = pending.get(event.id);
        if (waiter !== undefined) {
          pending.delete(event.id);
          waiter.resolve(event);
        }
      }
    }
  });

  async function request(command, timeoutMs = 30_000) {
    const id = `acceptance-${++sequence}`;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    const value = await Promise.race([response, timeoutAfter(timeoutMs, `RPC ${command.type}`)]);
    if (value.success !== true) throw new Error(`real Pi RPC ${command.type} failed: ${JSON.stringify(value)}\nstderr=${stderr}`);
    return value;
  }

  async function stop() {
    child.stdin.end();
    const [code, signal] = await Promise.race([once(child, "exit"), timeoutAfter(20_000, "real Pi RPC shutdown")]);
    if (code !== 0) throw new Error(`real Pi RPC shutdown failed: code=${code} signal=${signal}\n${stderr}`);
    for (const waiter of pending.values()) waiter.reject(new Error("RPC stopped"));
    pending.clear();
    if (buffer.trim().length > 0) throw new Error(`real Pi RPC left a partial JSON frame: ${JSON.stringify(buffer)}`);
  }

  return { child, events, request, stop, output: () => ({ stdout, stderr }) };
}

function controlReports(entriesResponse) {
  return (entriesResponse.data?.entries ?? [])
    .filter((entry) => entry.type === "custom" && entry.customType === "plugin-host:control-report-v1")
    .map((entry) => entry.data?.envelope)
    .filter(Boolean);
}

async function waitForControlReport(rpc, predicate, label, afterCount = 0, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const entries = await rpc.request({ type: "get_entries" });
    const matches = controlReports(entries).filter(predicate);
    if (matches.length > afterCount) return matches.at(-1);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  } while (Date.now() < deadline);
  throw new Error(`real Pi RPC timed out waiting for ${label}`);
}

async function runControlCommand(rpc, message, predicate, label) {
  const before = controlReports(await rpc.request({ type: "get_entries" })).filter(predicate).length;
  await rpc.request({ type: "prompt", message }, 60_000);
  return waitForControlReport(rpc, predicate, label, before);
}

async function waitForMarketplaceIdle(rpc, commandName, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let consecutiveIdle = 0;
  do {
    const report = await runControlCommand(
      rpc,
      `/${commandName} marketplace list`,
      (envelope) => envelope.command?.id === "marketplace.list",
      "marketplace idle observation",
    );
    consecutiveIdle = (report.data?.registrations ?? []).every((registration) => registration.refresh?.claim === undefined)
      ? consecutiveIdle + 1
      : 0;
    if (consecutiveIdle >= 2) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  } while (Date.now() < deadline);
  throw new Error(`real Pi RPC background marketplace refresh did not settle\n${rpc.output().stderr}`);
}

try {
  const packed = checked("npm", ["pack", "--json", "--silent", "--pack-destination", root], { cwd: project });
  const [{ filename }] = JSON.parse(packed.stdout);
  const consumer = join(root, "consumer");
  const home = join(root, "empty-home");
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const marketplace = join(root, "marketplace");
  await Promise.all([mkdir(consumer), mkdir(home), mkdir(workspace), mkdir(agentDir), mkdir(marketplace)]);
  await prepareMarketplace(marketplace);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));

  // Install the package-under-test tarball beside the exact package-pinned Pi
  // runtime without importing any source checkout files.
  await cp(join(project, "node_modules"), join(consumer, "node_modules"), { recursive: true, dereference: true });
  const packageRoot = join(consumer, "node_modules", "@nklisch", "pi-plugins");
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });
  checked("tar", ["-xzf", join(root, filename), "--strip-components=1", "-C", packageRoot]);

  const piRoot = join(consumer, "node_modules", "@earendil-works", "pi-coding-agent");
  const piMetadata = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8"));
  const hostMetadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (piMetadata.version !== "0.80.8") throw new Error(`real Pi acceptance requires exact 0.80.8, got ${piMetadata.version}`);
  if (JSON.stringify(hostMetadata.pi?.extensions) !== JSON.stringify(["./dist/pi/production-subagents-extension.js", "./dist/pi/extension.js"])) throw new Error("packed extension discovery metadata missing");
  if (await realpath(packageRoot) === project) throw new Error("packed package resolved to the source checkout");

  const cli = join(piRoot, piMetadata.bin.pi);
  const subagentsExtension = join(packageRoot, hostMetadata.pi.extensions[0]);
  const extension = join(packageRoot, hostMetadata.pi.extensions[1]);
  const collision = join(consumer, "collision-extension.mjs");
  await writeFile(collision, `export default function (pi) { pi.registerCommand("plugin", { description: "Acceptance collision", handler: async (_args, ctx) => { ctx.ui.notify("collision command", "info"); } }); pi.registerCommand("acceptance-tools", { description: "Report active acceptance tools", handler: async (_args, ctx) => { ctx.ui.notify(JSON.stringify(pi.getAllTools().map((tool) => tool.name).sort()), "info"); } }); }\n`);
  const commonArgs = [
    "--offline",
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "-e", collision,
    "-e", subagentsExtension,
    "-e", extension,
  ];
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    NODE_OPTIONS: "",
    NO_COLOR: "1",
  };

  // Real RPC proves public extension registration, collision ownership,
  // structured framing, canonical command execution, and durable local setup.
  const rpc = await startRpc({ cli, args: commonArgs, cwd: workspace, env });
  const commands = await rpc.request({ type: "get_commands" });
  const pluginCommands = commands.data.commands.filter((command) => command.source === "extension" && command.name.startsWith("plugin"));
  if (pluginCommands.length !== 2) throw new Error(`expected collision plus packed /plugin, got ${JSON.stringify(pluginCommands)}`);
  const owned = pluginCommands.find((command) => {
    const path = command.path ?? command.sourceInfo?.path;
    return typeof path === "string" && resolve(path) === resolve(extension);
  });
  if (owned === undefined || owned.name === "plugin") throw new Error(`packed command did not retain exact collision suffix ownership: ${JSON.stringify(pluginCommands)}`);
  if (!rpc.events.some((event) => event.type === "extension_ui_request" && event.method === "notify" && String(event.message).includes(`/${owned.name}`))) {
    throw new Error("real Pi collision notification did not name the exact suffixed command");
  }
  await rpc.request({ type: "prompt", message: "/acceptance-tools" });
  if (!rpc.events.some((event) => event.type === "extension_ui_request" && event.method === "notify" && String(event.message).includes('"mcp"'))) {
    throw new Error("real Pi did not register the isolated production MCP gateway");
  }

  const productionStatus = await runControlCommand(rpc, `/${owned.name} status`, (envelope) => envelope.command?.id === "status", "status completion");
  if (productionStatus.data?.capabilities?.mcp?.status !== "available") {
    throw new Error(`published MCP runtime did not pass concrete production qualification: ${JSON.stringify(productionStatus)}`);
  }
  if (productionStatus.data?.capabilities?.subagents?.status !== "available") {
    throw new Error(`bundled subagent extension did not resolve Pi peers and publish its qualified lifecycle: ${JSON.stringify(productionStatus)}`);
  }
  await runControlCommand(rpc, `/${owned.name} marketplace add ${marketplace} --source-kind local-git`, (envelope) => envelope.command?.id === "marketplace.add", "marketplace registration completion");
  await runControlCommand(rpc, `/${owned.name} browse demo --scope user --limit 50`, (envelope) => envelope.command?.id === "browse", "catalog browse completion");
  const entries = await rpc.request({ type: "get_entries" });
  const reports = controlReports(entries);
  if (!reports.some((envelope) => envelope.command?.id === "status" && envelope.status === "ok")) throw new Error("real Pi RPC status envelope missing");
  if (!reports.some((envelope) => envelope.command?.id === "browse" && envelope.status === "ok" && envelope.data?.candidates?.some((candidate) => candidate.plugin === "demo@acceptance-market"))) {
    throw new Error(`real Pi RPC did not discover local acceptance candidate: ${JSON.stringify(reports.at(-1))}`);
  }
  await runControlCommand(rpc, `/${owned.name}`, (envelope) => envelope.status === "presentation-required", "headless manager presentation result");
  // Every command wake is allowed to start detached marketplace maintenance.
  // Keep the real RPC process alive until its public registration view proves
  // that no durable refresh claim will be abandoned at shutdown.
  await waitForMarketplaceIdle(rpc, owned.name);
  await rpc.stop();

  const packageOnlyArgs = [
    "--offline", "--approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", extension,
  ];
  // Real JSON mode must remain strict JSONL even while the extension publishes
  // custom control frames and reports through Pi's session channel.
  const json = checked(process.execPath, [cli, ...packageOnlyArgs, "--mode", "json", "--no-session", "/plugin status"], { cwd: workspace, env, timeout: 60_000 });
  const jsonLines = json.stdout.split("\n").filter(Boolean);
  if (jsonLines.length === 0) throw new Error("real Pi JSON mode emitted no framing");
  for (const line of jsonLines) JSON.parse(line);

  // A minimal Node-owned PTY acceptance uses Python's standard-library pty
  // allocator only because Node 24 has no public PTY API. It drives the actual
  // package-pinned Pi CLI and the production extension without deep imports or
  // monkeypatches. Node 24 exposes no atomic no-replace directory rename, so
  // production correctly rejects projection before install mutation; successful
  // install/reload handoff remains covered at the strongest injected-platform
  // boundary. This PTY covers host reload, browse, exact trust, public rejection,
  // manager recovery, and graceful shutdown without pretending the limitation
  // is a successful install.
  const transcript = join(root, "real-pi-tui.log");
  const ptyDriver = join(root, "pty-driver.py");
  await writeFile(ptyDriver, String.raw`
import fcntl, json, os, pty, select, signal, struct, sys, termios, time
args = json.loads(sys.argv[1])
env = os.environ.copy()
pid, fd = pty.fork()
if pid == 0:
    os.chdir(args["cwd"])
    os.execve(args["node"], [args["node"], args["cli"], *args["argv"]], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
os.set_blocking(fd, False)
buffer = bytearray()
def pump(deadline):
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if not ready: continue
        try:
            chunk = os.read(fd, 65536)
        except BlockingIOError:
            continue
        except OSError:
            return False
        if not chunk: return False
        buffer.extend(chunk)
    return True
def wait_for(token, start=None, timeout=45):
    needle = token.encode()
    begin = len(buffer) if start is None else start
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if buffer.find(needle, begin) >= 0: return
        if not pump(min(deadline, time.monotonic() + 0.25)): break
    tail = bytes(buffer[-12000:]).decode("utf-8", "replace")
    raise RuntimeError("missing TUI token %r after %d bytes; tail=%r" % (token, begin, tail))
def send(data):
    os.write(fd, data)
def wait_for_retry(token, command, timeout=90):
    needle = token.encode()
    deadline = time.monotonic() + timeout
    attempt = 0
    while time.monotonic() < deadline:
        mark = len(buffer)
        send(command)
        step_deadline = min(deadline, time.monotonic() + 20)
        while time.monotonic() < step_deadline:
            if buffer.find(needle, mark) >= 0: return
            if not pump(min(step_deadline, time.monotonic() + 0.25)): break
        attempt += 1
    tail = bytes(buffer[-12000:]).decode("utf-8", "replace")
    raise RuntimeError("missing TUI token %r after %d attempts; tail=%r" % (token, attempt, tail))
wait_for("Plugin Host command collision", 0, 60)
mark = len(buffer); send(("/" + args["command"] + " status\r").encode()); wait_for("Plugin operation", mark, 60); wait_for("Result", mark, 60); send(b"\x1b"); pump(time.monotonic() + 0.5)
mark = len(buffer); send(b"/reload\r"); wait_for("Plugin Host command collision", mark, 60)
# The reloaded host admits commands only after session startup completes;
# retry the presentation command until the manager surface mounts.
wait_for_retry("Plugins", ("/" + args["command"] + "\r").encode())
wait_for("demo", 0, 60)
mark = len(buffer); send(b"\r"); wait_for("Runtime surface", mark, 60)
mark = len(buffer); send(b"\r"); wait_for("Add plugin to", mark, 60); send(b"\r"); wait_for("Step 1/2", mark, 60)
mark = len(buffer); send(b"\r"); wait_for("Added demo@", mark, 90); wait_for("session reloaded", mark, 90)
send(b"\x1b")
pump(time.monotonic() + 0.5)
send(b"\x04")
deadline = time.monotonic() + 30
status = None
while time.monotonic() < deadline:
    ended, raw = os.waitpid(pid, os.WNOHANG)
    if ended:
        status = raw
        break
    pump(time.monotonic() + 0.1)
if status is None:
    os.kill(pid, signal.SIGTERM)
    ended, status = os.waitpid(pid, 0)
with open(args["transcript"], "wb") as output: output.write(buffer)
if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
    raise RuntimeError("real Pi TUI exited with status %r" % status)
`);
  const pty = checked("python3", [ptyDriver, JSON.stringify({
    node: process.execPath,
    cli,
    cwd: workspace,
    argv: [...commonArgs, "--no-session"],
    command: owned.name,
    transcript,
  })], { cwd: workspace, env, timeout: 240_000 });
  const tuiBytes = await readFile(transcript, "utf8");
  for (const expected of ["Plugins", "Step 1/2", "Added demo@", "session reloaded", "Result", "demo"]) {
    if (!tuiBytes.includes(expected)) throw new Error(`real Pi PTY transcript missing ${expected}`);
  }
  if (tuiBytes.includes("SECRET-CANARY")) throw new Error("real Pi PTY transcript leaked a secret canary");

  console.log("isolated packed real Pi 0.80.8 RPC/JSON/PTY acceptance passed");
} finally {
  if (process.env.KEEP_PACKED_ACCEPTANCE === "1") console.error(`packed acceptance root retained at ${root}`);
  else {
    spawnSync("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
}
