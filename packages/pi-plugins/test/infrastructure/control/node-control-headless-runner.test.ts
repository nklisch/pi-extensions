import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runNodeNativeControlHeadless } from "../../../src/infrastructure/control/node-control-headless-runner.js";
import { createControlFixture } from "../../fixtures/native-control/control-fixture.js";

function collectingOutput() {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { output, text: () => Buffer.concat(chunks).toString("utf8") };
}

describe("Node native control headless runner", () => {
  it("delivers pre-execution usage bytes and the numeric usage exit", async () => {
    const { service, ids } = createControlFixture();
    const captured = collectingOutput();
    const exit = await runNodeNativeControlHeadless({
      control: service,
      argv: ["unknown-command"],
      stdout: captured.output,
    });
    expect(exit).toBe(2);
    expect(Buffer.byteLength(captured.text())).toBeGreaterThan(0);
    expect(captured.text()).toContain("Usage: plugin <command>");
    expect(ids.issue).not.toHaveBeenCalled();
  });

  it("streams JSON lines through the real facade and returns its semantic exit", async () => {
    const { service } = createControlFixture();
    const captured = collectingOutput();
    const exit = await runNodeNativeControlHeadless({
      control: service,
      argv: ["--output", "json", "status"],
      stdout: captured.output,
    });
    const lines = captured.text().trim().split("\n").map((line) => JSON.parse(line));
    expect(exit).toBe(0);
    expect(lines.map((line) => line.type)).toEqual(["accepted", "result"]);
    expect(lines[1]).toMatchObject({ result: { status: "ok", exit: { code: 0 } } });
  });

  it("renders only safe human fields rather than machine JSON", async () => {
    const { service } = createControlFixture();
    const captured = collectingOutput();
    const exit = await runNodeNativeControlHeadless({
      control: service,
      argv: ["--output", "human", "status"],
      stdout: captured.output,
    });
    expect(exit).toBe(0);
    expect(captured.text()).toBe("Show plugin host status\n");
    expect(captured.text()).not.toContain("{");
  });

  it("uses the Node stdin adapter and never invents input", async () => {
    const { service, applications } = createControlFixture();
    const token = `trusted-install-session-v1:123e4567-e89b-42d3-a456-426614174000.${"a".repeat(64)}`;
    applications.trustedInstallation.status.mockResolvedValue({
      kind: "found",
      session: {
        token,
        version: 0,
        state: "awaiting-input",
        expiresAt: 1000,
        fields: [],
        consent: { consentId: `trusted-install-consent-v1:sha256:${"b".repeat(64)}` },
        binding: {
          plugin: "demo@market",
          scope: { kind: "user" },
          immutableRevision: `sha256:${"c".repeat(64)}`,
          executableSurfaceDigest: `sha256:${"d".repeat(64)}`,
        },
        progress: [],
      },
    } as never);
    const captured = collectingOutput();
    const exit = await runNodeNativeControlHeadless({
      control: service,
      argv: ["--output", "json", "--input-stdin", "install", "apply", token],
      stdin: Readable.from(["{not-json"]),
      stdout: captured.output,
    });
    expect(exit).toBe(3);
    expect(captured.text()).toContain("CONTROL_INPUT_REQUIRED");
    expect(applications.trustedInstallation.activate).not.toHaveBeenCalled();
  });

  it("maps output callback EPIPE to the delivery exit", async () => {
    const { service } = createControlFixture();
    const broken = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("closed"), { code: "EPIPE" }));
      },
    });
    await expect(runNodeNativeControlHeadless({
      control: service,
      argv: ["--output", "json", "status"],
      stdout: broken,
    })).resolves.toBe(74);
  });
});
