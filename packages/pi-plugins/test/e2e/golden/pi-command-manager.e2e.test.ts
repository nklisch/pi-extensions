import { afterEach, describe, expect, it } from "vitest";
import { cleanupSandbox, createCleanE2ESandbox, type CleanE2ESandbox } from "../harness/environment.js";
import { seedRemoteMarketplace, startPackedRpc } from "../harness/journey.js";
import { PiPtyProcess } from "../harness/pi-pty.js";
import { diagnosePtyCapability } from "../harness/faults.js";
import { runChecked } from "../harness/process.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

describe("packed headless and native Pi manager parity", () => {
  it("returns presentation-required in RPC and bounded facade text in print mode", async () => {
    sandbox = await createCleanE2ESandbox("golden-headless-parity");
    const rpc = await startPackedRpc(sandbox);
    const presentation = await rpc.plugin("", "presentation");
    expect(presentation.envelope).toMatchObject({ status: "presentation-required", exit: { code: 3 } });
    await rpc.shutdown();

    const printed = await runChecked(sandbox.capabilities.node, [
      sandbox.piCli,
      "--offline", "--approve", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--mode", "text", "--print", "--no-session", "/plugin status",
    ], { cwd: sandbox.project, env: sandbox.env, timeoutMs: 30_000 });
    const userOutput = `${printed.stdout}${printed.stderr}`;
    expect(userOutput).toContain("Host ready · recovery settled · runtime reconciled");
    expect(userOutput).not.toContain("\u001b");
    expect(userOutput.length).toBeLessThan(65_536);
  });

  it("opens the real manager at wide and narrow dimensions with keyboard-only navigation", async () => {
    sandbox = await createCleanE2ESandbox("golden-native-manager");
    const ptyCapability = await diagnosePtyCapability(sandbox);
    if (!ptyCapability.available) {
      expect(ptyCapability.reason).toContain("util-linux PTY capability missing");
      return;
    }
    const journey = await seedRemoteMarketplace(sandbox);
    await journey.rpc.shutdown();

    const wide = await PiPtyProcess.start({ sandbox, columns: 120, rows: 30 });
    // Wait for Pi's interactive footer before dispatching the command; the
    // extension host admits commands only after session startup completes.
    await wide.waitFor("clear/exit", 0, 60_000);
    const start = wide.mark();
    wide.send("/plugin\r");
    await wide.waitFor("Plugins", start, 60_000);
    const browse = wide.mark();
    wide.send("\u001b[B\r");
    await wide.waitFor("core-local", browse, 60_000);
    wide.send("?\u001b");
    wide.send("\u001b\u0004");
    await wide.shutdown();

    const narrow = await PiPtyProcess.start({ sandbox, columns: 58, rows: 24 });
    await narrow.waitFor("clear/exit", 0, 60_000);
    const narrowStart = narrow.mark();
    narrow.send("/plugin\r");
    const output = await narrow.waitFor("Plugins", narrowStart, 60_000);
    expect(output.slice(narrowStart)).toContain("[all]");
    expect(output.slice(narrowStart)).toContain("installed");
    expect(output.slice(narrowStart)).toContain("available");
    expect(output.slice(narrowStart)).toContain("a add");
    expect(output.slice(narrowStart)).toContain("m marketplaces");
    narrow.send("\u001b\u0004");
    await narrow.shutdown();
  });

  it("renders the flattened signed add flow through the real PTY", async () => {
    sandbox = await createCleanE2ESandbox("golden-native-install");
    const ptyCapability = await diagnosePtyCapability(sandbox);
    if (!ptyCapability.available) {
      expect(ptyCapability.reason).toContain("util-linux PTY capability missing");
      return;
    }
    const journey = await seedRemoteMarketplace(sandbox);
    await journey.rpc.shutdown();
    const pty = await PiPtyProcess.start({ sandbox, columns: 120, rows: 30 });
    await pty.waitFor("clear/exit", 0, 60_000);
    let mark = pty.mark();
    pty.send("/plugin\r");
    await pty.waitFor("Plugins", mark, 60_000);
    await pty.waitFor("core-local", mark, 60_000);
    mark = pty.mark();
    pty.send("\r");
    await pty.waitFor("Runtime surface", mark, 90_000);
    mark = pty.mark();
    // Enter on the only detail action (Add plugin) chooses the install scope,
    // then opens the session directly: no review screen between detail and add.
    pty.send("\r");
    await pty.waitFor("Add plugin to", mark, 60_000);
    pty.send("\r");
    await pty.waitFor("Step 1/2 · Configure and add", mark, 60_000);
    // The single required field starts focused; Enter edits it in place.
    pty.send("\r");
    await pty.waitFor("editing", mark, 60_000);
    pty.send("e2e-value\r");
    await pty.waitFor("set: e2e-value", mark, 60_000);
    mark = pty.mark();
    // Field → disclosure → back → Add plugin; the disclosure is never a gate.
    pty.send("\u001b[B\u001b[B\u001b[B\r");
    await pty.waitFor("Added core-local", mark, 120_000);
    expect(pty.semanticOutput().slice(mark)).toContain("session reloaded");
    await pty.shutdown();
  });
});
