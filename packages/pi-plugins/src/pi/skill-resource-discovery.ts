import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  SkillResourceDiscoveryPort,
  SkillResourceDiscoveryResult,
} from "../runtime/skills/resource-discovery.js";

class SkillResourceDiscoveryAdapterError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SkillResourceDiscoveryAdapterError";
  }
}

function abortError(): DOMException {
  return new DOMException("skill resource discovery was cancelled", "AbortError");
}

function resultError(result: Extract<SkillResourceDiscoveryResult, { kind: "failed" }>): SkillResourceDiscoveryAdapterError {
  return new SkillResourceDiscoveryAdapterError(result.code);
}

/** Register only the Pi resource lifecycle seam; all policy stays host-neutral. */
export function registerSkillResourceDiscovery(
  pi: ExtensionAPI,
  resources: SkillResourceDiscoveryPort,
): void {
  if (pi === null || typeof pi !== "object" || typeof pi.on !== "function") throw new TypeError("Pi ExtensionAPI is required");
  if (resources === null || typeof resources !== "object" || typeof resources.discover !== "function") throw new TypeError("skill resource discovery port is required");
  const lifetime = new AbortController();

  // The root Pi barrel exposes ExtensionAPI's overload but does not re-export
  // the resource event aliases in 0.80.8. Leave both parameters contextually
  // typed by that overload rather than copying its private aliases locally.
  pi.on("resources_discover", async (event, ctx) => {
    if (event.cwd !== ctx.cwd) throw new SkillResourceDiscoveryAdapterError("CURRENT_PROJECT_MISMATCH");
    const result = await resources.discover({ reason: event.reason, projectTrusted: ctx.isProjectTrusted() }, lifetime.signal);
    // A shutdown can race the final await. The old extension instance must not
    // hand Pi a result produced after its lifetime ended, even if a non-conforming
    // host-neutral adapter ignored the signal.
    if (lifetime.signal.aborted) throw abortError();
    if (result.kind === "ready") return { skillPaths: [...result.skillPaths] };
    if (result.kind === "cancelled") throw abortError();
    throw resultError(result);
  });

  pi.on("session_shutdown", (): void => {
    if (!lifetime.signal.aborted) lifetime.abort();
  });
}