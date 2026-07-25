import { createMcpRuntimeCapabilityProbe } from "../application/mcp-runtime-capability-probe.js";
import { createSubagentLifecycleCapabilityProbe } from "../application/subagent-lifecycle-capability-probe.js";
import type { HookExecutableResolverPort } from "../application/ports/hook-executable-resolver.js";
import type { RuntimeCapabilityProbe } from "../application/ports/runtime-capability-probe.js";
import {
  RuntimeCapabilityRegistry,
  RuntimeCapabilitySnapshotSchema,
  type RuntimeCapabilityAvailability,
} from "../domain/compatibility-policy.js";
import type { RuntimeParticipantQualification } from "./runtime-participant-qualification.js";

async function executableAvailable(
  resolver: HookExecutableResolverPort,
  commands: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  for (const command of commands) {
    try {
      await resolver.resolve({
        command,
        cwd: "/",
        environment: { inherit: "host", values: {} },
      }, signal);
      return true;
    } catch {
      if (signal.aborted) throw signal.reason;
    }
  }
  return false;
}

function fact(available: boolean, yes: string, no: string): RuntimeCapabilityAvailability {
  return Object.freeze({ status: available ? "available" : "unavailable", explanation: available ? yes : no });
}

/** Complete capability chain; optional participants remain truthful absence. */
export function createNodePiRuntimeCapabilityProbe(input: Readonly<{
  executables: HookExecutableResolverPort;
  qualification: RuntimeParticipantQualification;
}>): RuntimeCapabilityProbe {
  if (input.qualification === null || typeof input.qualification !== "object" ||
      input.executables === null || typeof input.executables !== "object") {
    throw new TypeError("Node/Pi capability probe dependencies are invalid");
  }
  const base: RuntimeCapabilityProbe = Object.freeze({
    async snapshot(signal: AbortSignal) {
      signal.throwIfAborted();
      const [bash, powershell] = await Promise.all([
        executableAvailable(input.executables, ["bash"], signal),
        executableAvailable(input.executables, ["pwsh", "powershell"], signal),
      ]);
      const unavailable = "capability is supplied only by an optional runtime participant";
      const capabilities = Object.fromEntries(
        Object.values(RuntimeCapabilityRegistry).map((entry) => [entry.id, fact(false, unavailable, unavailable)]),
      );
      Object.assign(capabilities, {
        [RuntimeCapabilityRegistry.skillToolRestrictions.id]: fact(input.qualification.hostApi.status === "available", "Pi skill tool restrictions are composed", input.qualification.hostApi.explanation),
        [RuntimeCapabilityRegistry.commandHooks.id]: fact(input.qualification.hostApi.status === "available", "Pi command-hook runtime is composed", input.qualification.hostApi.explanation),
        [RuntimeCapabilityRegistry.bash.id]: fact(bash, "Bash is locally available", "Bash is not locally available"),
        [RuntimeCapabilityRegistry.powershell.id]: fact(powershell, "PowerShell is locally available", "PowerShell is not locally available"),
      });
      return RuntimeCapabilitySnapshotSchema.parse({ capabilities, capturedBy: "node-pi-base-v1" });
    },
  });
  const mcp = createMcpRuntimeCapabilityProbe({
    base,
    ...(input.qualification.mcp.runtime === undefined ? {} : { runtime: input.qualification.mcp.runtime }),
    capturedBy: "node-pi-mcp-v1",
  });
  return createSubagentLifecycleCapabilityProbe({
    base: mcp,
    ...(input.qualification.subagents.lifecycle === undefined ? {} : { lifecycle: input.qualification.subagents.lifecycle }),
    capturedBy: "node-pi-runtime-v1",
    runtime: { nodeVersion: input.qualification.nodeVersion, piVersion: input.qualification.piVersion },
  });
}
