import { execPath } from "node:process";
import { describe, expect, it } from "vitest";
import {
  CommandRunnerError,
  createNodeCommandRunner,
} from "../../../src/infrastructure/process/command-runner.js";
import { redactCommand, redactEnvironment, redactText } from "../../../src/infrastructure/logging/redaction.js";

describe("argument-array command runner", () => {
  it("passes arguments literally without a shell and captures stderr", async () => {
    const result = await createNodeCommandRunner().run({
      executable: execPath,
      args: ["-e", "process.stdout.write(process.argv[1]); process.stderr.write('diagnostic')", "$(not-a-command)"],
      cwd: process.cwd(),
      environment: { inherit: "host", values: {} },
      capture: {
        stdout: { mode: "capture", maxBytes: 1024, overflow: "error" },
        stderr: { maxBytes: 1024, overflow: "truncate" },
      },
    }, new AbortController().signal);

    expect(new TextDecoder().decode(result.stdout as Uint8Array)).toBe("$(not-a-command)");
    expect(new TextDecoder().decode(result.stderr)).toBe("diagnostic");
    expect(result.exitCode).toBe(0);
  });

  it("rejects output over the configured capture limit after draining and killing", async () => {
    await expect(createNodeCommandRunner({ killGraceMs: 0 }).run({
      executable: execPath,
      args: ["-e", "process.stdout.write('too much'); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      environment: { inherit: "host", values: {} },
      capture: {
        stdout: { mode: "capture", maxBytes: 3, overflow: "error" },
        stderr: { maxBytes: 1024, overflow: "truncate" },
      },
    }, new AbortController().signal)).rejects.toBeInstanceOf(CommandRunnerError);
  });

  it("returns nonzero exit status without serializing native stderr", async () => {
    const result = await createNodeCommandRunner().run({
      executable: execPath,
      args: ["-e", "process.stderr.write('native detail'); process.exit(2)"],
      cwd: process.cwd(),
      environment: { inherit: "none", values: { NODE_ENV: "hook-test" } },
      capture: {
        stdout: { mode: "capture", maxBytes: 1024, overflow: "error" },
        stderr: { maxBytes: 1024, overflow: "truncate" },
      },
    }, new AbortController().signal);
    expect(result.exitCode).toBe(2);
    expect(new TextDecoder().decode(result.stderr)).toBe("native detail");
    expect(result.stderrTruncated).toBe(false);
  });

  it("enforces a timeout through the same process-tree termination path", async () => {
    await expect(createNodeCommandRunner({ killGraceMs: 0 }).run({
      executable: execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      environment: { inherit: "host", values: {} },
      timeoutMs: 20,
      capture: {
        stdout: { mode: "capture", maxBytes: 1024, overflow: "error" },
        stderr: { maxBytes: 1024, overflow: "truncate" },
      },
    }, new AbortController().signal)).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("truncates stderr only when the caller explicitly chooses truncation", async () => {
    const result = await createNodeCommandRunner().run({
      executable: execPath,
      args: ["-e", "process.stderr.write('0123456789')"],
      cwd: process.cwd(),
      environment: { inherit: "none", values: {} },
      capture: {
        stdout: { mode: "capture", maxBytes: 1024, overflow: "error" },
        stderr: { maxBytes: 3, overflow: "truncate" },
      },
    }, new AbortController().signal);
    expect(new TextDecoder().decode(result.stderr)).toBe("012");
    expect(result.stderrTruncated).toBe(true);
  });

  it("terminates a running process and preserves the caller's abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const running = await createNodeCommandRunner({ killGraceMs: 0 }).run({
      executable: execPath,
      args: ["-e", "setInterval(() => process.stdout.write('x'), 10)"],
      cwd: process.cwd(),
      environment: { inherit: "host", values: {} },
      capture: {
        stdout: { mode: "stream", maxBytes: 1024, overflow: "error" },
        stderr: { maxBytes: 1024, overflow: "truncate" },
      },
    }, controller.signal);
    setTimeout(() => controller.abort(reason), 30).unref();
    await expect(running.completion).rejects.toBe(reason);
  });
});

describe("structured redaction", () => {
  it("removes explicit and structural credential forms", () => {
    const secret = "recognizable-secret";
    expect(redactText(`https://user:${secret}@example.test/x?token=${secret} Bearer ${secret}`, [secret])).not.toContain(secret);
    expect(redactCommand("git", ["fetch", `https://user:${secret}@example.test/repo`], [secret]).args.join(" ")).not.toContain(secret);
    expect(redactEnvironment({ API_TOKEN: secret, HOME: "/tmp" }, [secret]).API_TOKEN).toBe("[REDACTED]");
  });

  it("classifies cookie, signature, session, and JWT-style carriers consistently", () => {
    const secret = "CANARY_STRUCTURED_CREDENTIAL";
    const redacted = redactText(
      `https://example.test/x?sig=${secret}&X-Amz-Signature=${secret}&session=${secret}&jwt=${secret}`,
    );
    expect(redacted).not.toContain(secret);
    expect(redactEnvironment({
      Cookie: secret,
      "X-Amz-Signature": secret,
      SESSION_ID: secret,
      JWT: secret,
    })).toEqual({
      Cookie: "[REDACTED]",
      "X-Amz-Signature": "[REDACTED]",
      SESSION_ID: "[REDACTED]",
      JWT: "[REDACTED]",
    });
  });
});
