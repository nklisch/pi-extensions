import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  PackagedPluginHostError,
  PackagedPluginHostErrorCode,
} from "../composition/packaged-plugin-host-contract.js";

const REGISTRY = Symbol.for("@nklisch/pi-plugins/composition-v1");

type SessionOwner = {
  readonly claim: object;
  drainingTicket?: string;
};
type CompositionRegistry = {
  readonly version: 1;
  readonly roots: WeakMap<object, object>;
  readonly sessions: Map<string, SessionOwner[]>;
};

function registry(): CompositionRegistry {
  const root = globalThis as typeof globalThis & { [REGISTRY]?: CompositionRegistry };
  const existing = root[REGISTRY];
  if (existing !== undefined) return existing;
  const created: CompositionRegistry = {
    version: 1,
    roots: new WeakMap<object, object>(),
    sessions: new Map<string, SessionOwner[]>(),
  };
  Object.defineProperty(root, REGISTRY, { value: created, configurable: false, enumerable: false });
  return created;
}

export type PluginHostCompositionClaim = Readonly<{
  claimSession(sessionId: string, reloadTicket?: string): void;
  markDraining(reloadTicket: string): void;
  releaseSession(): void;
  release(): void;
}>;

/** Reserve process-local Pi/session ownership before any startup adapter opens. */
export function claimPackagedPluginHostComposition(pi: ExtensionAPI): PluginHostCompositionClaim {
  if (pi === null || typeof pi !== "object" || typeof pi.on !== "function") {
    throw new PackagedPluginHostError(PackagedPluginHostErrorCode.invalidOptions, "Pi ExtensionAPI is required");
  }
  const state = registry();
  if (state.roots.has(pi)) {
    throw new PackagedPluginHostError(
      PackagedPluginHostErrorCode.duplicateComposition,
      "a packaged plugin host is already composed for this Pi runtime",
    );
  }
  const claim = Object.freeze({});
  state.roots.set(pi, claim);
  let sessionId: string | undefined;
  let released = false;

  function owner(): SessionOwner | undefined {
    if (sessionId === undefined) return undefined;
    return state.sessions.get(sessionId)?.find((candidate) => candidate.claim === claim);
  }

  function releaseSession(): void {
    if (sessionId === undefined) return;
    const owners = state.sessions.get(sessionId);
    if (owners !== undefined) {
      const next = owners.filter((candidate) => candidate.claim !== claim);
      if (next.length === 0) state.sessions.delete(sessionId);
      else state.sessions.set(sessionId, next);
    }
    sessionId = undefined;
  }

  return Object.freeze({
    claimSession(nextSessionId: string, reloadTicket?: string): void {
      if (released) {
        throw new PackagedPluginHostError(PackagedPluginHostErrorCode.terminal, "composition claim was released");
      }
      if (sessionId === nextSessionId) return;
      if (sessionId !== undefined || typeof nextSessionId !== "string" || nextSessionId.length === 0) {
        throw new PackagedPluginHostError(PackagedPluginHostErrorCode.duplicateSession, "host session ownership is invalid");
      }
      const owners = state.sessions.get(nextSessionId) ?? [];
      const predecessor = owners.length === 1 ? owners[0] : undefined;
      const exactSuccessor = predecessor !== undefined &&
        reloadTicket !== undefined && predecessor.drainingTicket === reloadTicket;
      if (owners.length > 0 && !exactSuccessor) {
        throw new PackagedPluginHostError(
          PackagedPluginHostErrorCode.duplicateSession,
          "another packaged plugin host owns this Pi session",
        );
      }
      if (owners.length > 1) {
        throw new PackagedPluginHostError(PackagedPluginHostErrorCode.duplicateSession, "reload overlap is already occupied");
      }
      state.sessions.set(nextSessionId, [...owners, { claim }]);
      sessionId = nextSessionId;
    },
    markDraining(reloadTicket: string): void {
      if (typeof reloadTicket !== "string" || reloadTicket.length === 0) {
        throw new TypeError("reload ticket must be non-empty");
      }
      const current = owner();
      if (current === undefined) {
        throw new PackagedPluginHostError(PackagedPluginHostErrorCode.terminal, "no active session claim");
      }
      current.drainingTicket = reloadTicket;
    },
    releaseSession,
    release(): void {
      if (released) return;
      released = true;
      releaseSession();
      if (state.roots.get(pi) === claim) state.roots.delete(pi);
    },
  });
}

export type PluginHostBootstrapTarget = Readonly<{
  sessionStart(event: SessionStartEvent, context: ExtensionContext): Promise<void> | void;
  resourcesDiscover?(
    event: Readonly<{ type: "resources_discover"; cwd: string; reason: "startup" | "reload" }>,
    context: ExtensionContext,
  ): Promise<Readonly<{ skillPaths?: string[] }> | void> | Readonly<{ skillPaths?: string[] }> | void;
  sessionShutdown(event: SessionShutdownEvent, context: ExtensionContext): Promise<void> | void;
}>;

export type PluginHostBootstrap = Readonly<{
  activate(target: PluginHostBootstrapTarget): void;
  clear(target?: PluginHostBootstrapTarget): void;
}>;

/** Register the minimum inert delegates needed to receive explicit Pi lifecycle calls. */
export function createPluginHostBootstrap(pi: ExtensionAPI): PluginHostBootstrap {
  if (pi === null || typeof pi !== "object" || typeof pi.on !== "function") {
    throw new PackagedPluginHostError(PackagedPluginHostErrorCode.invalidOptions, "Pi ExtensionAPI is required");
  }
  let target: PluginHostBootstrapTarget | undefined;
  pi.on("session_start", async (event, context) => {
    await target?.sessionStart(event, context);
  });
  pi.on("resources_discover", async (event, context) => {
    return await target?.resourcesDiscover?.(event, context);
  });
  pi.on("session_shutdown", async (event, context) => {
    await target?.sessionShutdown(event, context);
  });
  return Object.freeze({
    activate(next): void {
      if (target !== undefined && target !== next) {
        throw new PackagedPluginHostError(PackagedPluginHostErrorCode.duplicateComposition, "bootstrap target is already active");
      }
      target = next;
    },
    clear(expected): void {
      if (expected === undefined || target === expected) target = undefined;
    },
  });
}
