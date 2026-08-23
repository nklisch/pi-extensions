/**
 * Command transform store — Pi event-bus collector for bash command transforms.
 *
 * Mirrors the package-registration store: the core extension constructs a store
 * at composition time; the store registers a listener for
 * {@link AUTO_REVIEWER_TRANSFORMS_REGISTER_EVENT} during construction (before
 * any collection request), then {@link CommandTransformStore.collect} emits a
 * fresh {@link AUTO_REVIEWER_TRANSFORMS_REQUEST_EVENT} and synchronously
 * captures the transforms that contributors emit in response.
 *
 * The store is discovery-only and in-memory. It never runs a transform, calls
 * Pi UI directly, or mutates a command — that is the handler's job, which
 * `await`s {@link CommandTransformStore.runTransforms} on the allow branch.
 *
 * Reload safety: `collect` clears previous state and mints a new request id,
 * so stale responses to older request ids are ignored and removed/changed
 * contributors disappear after a reload. `dispose` unregisters the store's
 * event-bus listener when Pi tears down an extension instance.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AUTO_REVIEWER_TRANSFORMS_API_VERSION,
  AUTO_REVIEWER_TRANSFORMS_REGISTER_EVENT,
  AUTO_REVIEWER_TRANSFORMS_REQUEST_EVENT,
  type AutoReviewerTransformsRequest,
  type CommandTransformIssue,
  type CommandTransformResult,
  normalizeCommandTransformRegistration,
} from "./transform-contract.ts";

/** Why the store is collecting registrations. Echoed to contributors. */
export type TransformCollectReason = "startup" | "reload" | "manual";

/**
 * A stable, point-in-time view of collected transforms. The array is a shallow
 * copy so a snapshot stays deterministic even if the store collects again or
 * receives an out-of-band registration.
 */
export interface TransformSnapshot {
  /** The request id of the last collect, or null before the first collect. */
  readonly requestId: string | null;
  readonly transforms: readonly {
    readonly id: string;
    readonly description: string;
  }[];
  readonly issues: readonly CommandTransformIssue[];
}

/** The outcome of running the transform chain for one command. */
export interface TransformChainResult {
  /** The command to run after transforms, or the original if none applied. */
  readonly command: string;
  /** Whether any transform changed the command. */
  readonly changed: boolean;
  /**
   * The last transform that reported a skip/error, for diagnostics. A
   * transform that returns `{ command }` is not a skip. Empty when every
   * transform either applied or silently opted out.
   */
  readonly lastNote?: {
    readonly id: string;
    readonly kind: "skipped" | "error";
    readonly message: string;
  };
}

/** Input to {@link createCommandTransformStore}. */
export interface CreateCommandTransformStoreInput {
  /**
   * Pi event bus. Omitted (or absent on older Pi versions) yields an inert
   * store that reports an empty snapshot with a `no-event-bus` warning;
   * transforms stay unavailable and approved commands run unchanged.
   */
  readonly events?: {
    on?: (channel: string, handler: (data: unknown) => void) => () => void;
    emit?: (channel: string, data: unknown) => void;
  };
}

/** Issue recorded when the Pi event bus is unavailable. */
const NO_EVENT_BUS_ISSUE: CommandTransformIssue = {
  severity: "warning",
  code: "no-event-bus",
  path: "event",
  message:
    "Pi event bus is unavailable; command transforms are unavailable until a Pi version with pi.events is used.",
};

/**
 * Build a command transform store bound to a Pi event bus.
 *
 * The register-event listener is installed before this function returns, so a
 * contributor that responds synchronously to the first request is captured
 * even if it registered its request listener after the store was constructed
 * (as long as that happens before the first collect).
 */
export function createCommandTransformStore(
  input: CreateCommandTransformStoreInput,
): CommandTransformStore {
  const events = input.events;

  // Absent event-bus fallback: an inert store. Transforms remain unavailable
  // and approved commands run unchanged. collect/runTransforms are safe no-ops.
  if (
    events === undefined ||
    events.on === undefined ||
    events.emit === undefined
  ) {
    const inertSnapshot: TransformSnapshot = {
      requestId: null,
      transforms: [],
      issues: [NO_EVENT_BUS_ISSUE],
    };
    return {
      snapshot: () => inertSnapshot,
      collect: () => inertSnapshot,
      runTransforms: async (command) => ({ command, changed: false }),
      clear: () => {
        /* no event bus: nothing to clear */
      },
      dispose: () => {
        /* no event bus: no listener to dispose */
      },
    };
  }

  const bus = events;
  const { on: busOn, emit: busEmit } = bus;
  if (busOn === undefined || busEmit === undefined) {
    // Defensive: the top-of-function guard already covered this, but keep a
    // local narrowing so TypeScript sees busOn/busEmit as defined below.
    return {
      snapshot: () => ({
        requestId: null,
        transforms: [],
        issues: [NO_EVENT_BUS_ISSUE],
      }),
      collect: () => ({
        requestId: null,
        transforms: [],
        issues: [NO_EVENT_BUS_ISSUE],
      }),
      runTransforms: async (command) => ({ command, changed: false }),
      clear: () => {},
      dispose: () => {},
    };
  }
  const on = busOn;
  const emit = busEmit;

  type StoredTransform = {
    readonly id: string;
    readonly description: string;
    readonly run: (
      command: string,
      ctx: ExtensionContext,
    ) => Promise<CommandTransformResult>;
  };

  let transforms: StoredTransform[] = [];
  let issues: CommandTransformIssue[] = [];
  let currentRequestId: string | null = null;
  let requestCounter = 0;
  let disposed = false;

  function resetState(): void {
    transforms = [];
    issues = [];
    currentRequestId = null;
  }

  function recordListenerIssue(code: string, error: unknown): void {
    const message = `command transform registration event handler failed: ${errorMessage(error)}`;
    issues.push({ severity: "error", code, path: "event", message });
    console.error(`Pi Clearance ${message}`);
  }

  const unsubscribeRegister = on(
    AUTO_REVIEWER_TRANSFORMS_REGISTER_EVENT,
    (data: unknown) => {
      try {
        if (disposed) {
          return;
        }

        // This is a raw event-bus callback. Keep request-id getters,
        // normalization, and array updates in one containment block: a
        // contributor can supply a Proxy/getter rather than a plain object.
        const rawRequestId = readRequestId(data);
        if (rawRequestId !== undefined && rawRequestId !== currentRequestId) {
          // Stale response for a request we are no longer servicing. Ignore it
          // so stale data can never widen the transform set.
          issues.push({
            severity: "warning",
            code: "stale-registration",
            path: "event",
            message: buildStaleMessage(rawRequestId, currentRequestId),
          });
          return;
        }

        const result = normalizeCommandTransformRegistration(data);
        if (result.transform !== null) {
          transforms.push({
            id: result.transform.id,
            description: result.transform.description,
            run: result.transform.transform,
          });
        }
        for (const issue of result.issues) {
          issues.push(issue);
        }
      } catch (error) {
        // Do not rely on Pi's event bus swallowing errors. This listener is an
        // extension-owned out-of-band boundary and must be total on its own.
        recordListenerIssue("listener-error", error);
      }
    },
  );

  function collect(reason: TransformCollectReason): TransformSnapshot {
    if (disposed) {
      return snapshot();
    }

    resetState();
    requestCounter += 1;
    const requestId = `pi-clearance:transforms:request:${requestCounter}`;
    currentRequestId = requestId;

    const request: AutoReviewerTransformsRequest = {
      apiVersion: AUTO_REVIEWER_TRANSFORMS_API_VERSION,
      requestId,
      reason,
    };

    try {
      emit(AUTO_REVIEWER_TRANSFORMS_REQUEST_EVENT, request);
    } catch (error) {
      issues.push({
        severity: "error",
        code: "collection-error",
        path: "event",
        message: `transform registration request failed: ${errorMessage(error)}`,
      });
    }

    return snapshot();
  }

  function clear(): void {
    if (disposed) {
      return;
    }
    resetState();
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribeRegister();
    resetState();
  }

  function snapshot(): TransformSnapshot {
    return {
      requestId: currentRequestId,
      transforms: transforms.map((t) => ({
        id: t.id,
        description: t.description,
      })),
      issues: [...issues],
    };
  }

  /**
   * Run every collected transform against the original command, in
   * registration order. Each transform sees the ORIGINAL command, not the
   * output of an earlier transform; the final command is the last `{ command }`
   * returned. A transform that throws or returns `{ error }` fails open (the
   * prior command is preserved) and its error is recorded as lastNote.
   *
   * This is the only place transforms actually execute — the store itself is
   * discovery-only. The handler calls this on the allow branch.
   */
  async function runTransforms(
    command: string,
    ctx: ExtensionContext,
  ): Promise<TransformChainResult> {
    if (transforms.length === 0) {
      return { command, changed: false };
    }

    let current = command;
    let changed = false;
    let lastNote: TransformChainResult["lastNote"];

    for (const transform of transforms) {
      try {
        const result = await transform.run(current, ctx);
        if (result.error !== undefined) {
          lastNote = { id: transform.id, kind: "error", message: result.error };
          // fail open: keep current command
          continue;
        }
        if (result.skipped !== undefined) {
          lastNote = {
            id: transform.id,
            kind: "skipped",
            message: result.skipped,
          };
          continue;
        }
        if (typeof result.command === "string" && result.command !== current) {
          current = result.command;
          changed = true;
          lastNote = undefined;
        }
      } catch (error) {
        lastNote = {
          id: transform.id,
          kind: "error",
          message: errorMessage(error),
        };
        // fail open: keep current command
      }
    }

    return changed
      ? {
          command: current,
          changed: true,
          ...(lastNote === undefined ? {} : { lastNote }),
        }
      : {
          command,
          changed: false,
          ...(lastNote === undefined ? {} : { lastNote }),
        };
  }

  return { snapshot, collect, runTransforms, clear, dispose };
}

/**
 * In-memory, awaitable command-transform store. The handler holds one and
 * `await`s runTransforms on the allow branch.
 */
export interface CommandTransformStore {
  /** The current collected state. Stable until the next collect/clear. */
  readonly snapshot: () => TransformSnapshot;
  /**
   * Clear previous state, emit a fresh request, synchronously capture
   * responses, and return the new snapshot.
   */
  readonly collect: (reason: TransformCollectReason) => TransformSnapshot;
  /** Run the collected transforms against a command. Fail-open on any error. */
  readonly runTransforms: (
    command: string,
    ctx: ExtensionContext,
  ) => Promise<TransformChainResult>;
  /** Drop all collected state and reset the request id. */
  readonly clear: () => void;
  /** Unsubscribe from the event bus and drop state for extension teardown. */
  readonly dispose: () => void;
}

function readRequestId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const requestId = (data as { readonly requestId?: unknown }).requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

function buildStaleMessage(
  rawRequestId: string,
  currentRequestId: string | null,
): string {
  return currentRequestId === null
    ? `Ignoring transform registration for request id "${rawRequestId}" (no active collection).`
    : `Ignoring transform registration for stale request id "${rawRequestId}" (current "${currentRequestId}").`;
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}
