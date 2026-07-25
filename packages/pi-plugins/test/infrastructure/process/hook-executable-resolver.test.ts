import { describe, expect, it } from "vitest";
import { createNodeHookExecutableResolver } from "../../../src/infrastructure/process/hook-executable-resolver.js";
import type { CommandEnvironment } from "../../../src/application/ports/process-runner.js";

function environment(values: Record<string, string | undefined> = {}, inherit: "host" | "none" = "none"): CommandEnvironment {
  return { inherit, values };
}

function accessFor(existing: readonly string[], calls: string[] = []) {
  const available = new Set(existing);
  return {
    calls,
    access: async (path: string): Promise<void> => {
      calls.push(path);
      if (!available.has(path)) throw new Error("missing");
    },
  };
}

describe("hook executable resolver", () => {
  it("resolves absolute and cwd-relative executables without consulting the host OS", async () => {
    const absolute = accessFor(["/opt/hooks/run"]);
    const resolver = createNodeHookExecutableResolver({ platform: "linux", access: absolute.access });
    await expect(resolver.resolve({ command: "/opt/hooks/run", cwd: "/workspace", environment: environment() }, new AbortController().signal))
      .resolves.toMatchObject({ executable: "/opt/hooks/run", resolution: "absolute" });

    const relative = accessFor(["/workspace/hooks/run"]);
    const relativeResolver = createNodeHookExecutableResolver({ platform: "linux", access: relative.access });
    await expect(relativeResolver.resolve({ command: "./hooks/run", cwd: "/workspace", environment: environment() }, new AbortController().signal))
      .resolves.toMatchObject({ executable: "/workspace/hooks/run", resolution: "cwd-relative" });
  });

  it("looks up POSIX PATH entries relative to the requested cwd and supports injected host PATH", async () => {
    const explicit = accessFor(["/workspace/tools/hook"]);
    const resolver = createNodeHookExecutableResolver({ platform: "linux", access: explicit.access });
    await expect(resolver.resolve({ command: "hook", cwd: "/workspace", environment: environment({ PATH: "tools:/missing" }) }, new AbortController().signal))
      .resolves.toMatchObject({ executable: "/workspace/tools/hook", resolution: "path" });

    const host = accessFor(["/host/bin/hook"]);
    const hostResolver = createNodeHookExecutableResolver({ platform: "linux", hostEnvironment: { PATH: "/host/bin" }, access: host.access });
    await expect(hostResolver.resolve({ command: "hook", cwd: "/workspace", environment: environment({}, "host") }, new AbortController().signal))
      .resolves.toMatchObject({ executable: "/host/bin/hook", resolution: "path" });
  });

  it("uses deterministic Windows PATH candidates and Windows path rules", async () => {
    const calls: string[] = [];
    const fakeAccess = accessFor(["C:\\workspace\\tools\\hook.bat"], calls);
    const resolver = createNodeHookExecutableResolver({ platform: "win32", access: fakeAccess.access });
    const result = await resolver.resolve({
      command: "hook",
      cwd: "C:\\workspace",
      environment: environment({ PATH: "tools;C:\\missing" }),
    }, new AbortController().signal);

    expect(result).toMatchObject({ executable: "C:\\workspace\\tools\\hook.bat", resolution: "path" });
    expect(calls.slice(0, 4)).toEqual([
      "C:\\workspace\\tools\\hook",
      "C:\\workspace\\tools\\hook.exe",
      "C:\\workspace\\tools\\hook.cmd",
      "C:\\workspace\\tools\\hook.bat",
    ]);

    const relative = accessFor(["C:\\workspace\\bin\\run.exe"]);
    const relativeResolver = createNodeHookExecutableResolver({ platform: "win32", access: relative.access });
    await expect(relativeResolver.resolve({ command: "bin\\run.exe", cwd: "C:\\workspace", environment: environment() }, new AbortController().signal))
      .resolves.toMatchObject({ executable: "C:\\workspace\\bin\\run.exe", resolution: "cwd-relative" });
  });

  it("reports missing executables and propagates cancellation from resolution", async () => {
    const resolver = createNodeHookExecutableResolver({ platform: "linux", access: accessFor([]).access });
    await expect(resolver.resolve({ command: "missing", cwd: "/workspace", environment: environment({ PATH: "/bin" }) }, new AbortController().signal))
      .rejects.toMatchObject({ name: "HookExecutableResolutionError" });

    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const resolverWithAbort = createNodeHookExecutableResolver({
      platform: "linux",
      access: async () => {
        controller.abort(reason);
        throw new Error("access interrupted");
      },
    });
    await expect(resolverWithAbort.resolve({ command: "hook", cwd: "/workspace", environment: environment({ PATH: "/bin" }) }, controller.signal))
      .rejects.toBe(reason);
  });
});
