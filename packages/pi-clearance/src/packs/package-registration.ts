/**
 * Package registration — Pi event-bus collector and reload-safe registration store.
 *
 * This module wires the {@link normalizePackagePackRegistration pure contract}
 * to Pi's inter-extension event bus. The core extension constructs a store at
 * composition time; the store registers a listener for
 * {@link AUTO_REVIEWER_PACKS_REGISTER_EVENT} during construction (before any
 * collection request), then {@link PackageRegistrationStore.collect} emits a
 * fresh {@link AUTO_REVIEWER_PACKS_REQUEST_EVENT} and synchronously captures
 * the registrations that contributors emit in response.
 *
 * The store is discovery-only and in-memory. It never reads package files,
 * installs packages, prompts users, calls Pi UI, or composes policy. Package
 * packs collected here are available-but-disabled data; enablement and
 * policy-cache integration are owned by downstream stories. A collected
 * snapshot is a stable, deterministic view for registry building and tests.
 *
 * Reload safety: `collect` clears previous state and mints a new request id,
 * so stale responses to older request ids are ignored (with a warning) and
 * removed/changed packages disappear after a reload. `dispose` unregisters the
 * store's event-bus listener when Pi tears down an extension instance, keeping
 * registration state scoped to that instance's lifetime.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AUTO_REVIEWER_PACK_REGISTRATION_API_VERSION,
  AUTO_REVIEWER_PACKS_REGISTER_EVENT,
  AUTO_REVIEWER_PACKS_REQUEST_EVENT,
  type AutoReviewerPackRegistrationRequest,
  type NormalizedPackagePack,
  normalizePackagePackRegistration,
  type PackageRegistrationIssue,
} from "./package-contract.ts";

/** Why the store is collecting registrations. Echoed to contributors. */
export type PackageRegistrationCollectReason = "startup" | "reload" | "manual";

/**
 * A stable, point-in-time view of collected package registrations. The arrays
 * are shallow copies so a snapshot stays deterministic even if the store
 * collects again or receives an out-of-band registration.
 */
export interface PackageRegistrationSnapshot {
  /** The request id of the last collect, or null before the first collect. */
  readonly requestId: string | null;
  readonly packs: readonly NormalizedPackagePack[];
  readonly issues: readonly PackageRegistrationIssue[];
}

/**
 * In-memory store of package registrations collected from the Pi event bus.
 * Construct one per extension instance in the Pi composition root.
 */
export interface PackageRegistrationStore {
  /** The current collected state. Stable until the next collect/clear. */
  readonly snapshot: () => PackageRegistrationSnapshot;
  /**
   * Clear previous state, emit a fresh request, synchronously capture
   * responses, notify {@link CreatePackageRegistrationStoreInput.onChange}, and
   * return the new snapshot.
   */
  readonly collect: (
    reason: PackageRegistrationCollectReason,
  ) => PackageRegistrationSnapshot;
  /** Drop all collected state and reset the request id. Notifies onChange. */
  readonly clear: () => void;
  /** Unsubscribe from the event bus and drop state for extension teardown. */
  readonly dispose: () => void;
}

/** Input to {@link createPackageRegistrationStore}. */
export interface CreatePackageRegistrationStoreInput {
  /**
   * Pi event bus. Omitted (or absent on older Pi versions) yields an inert
   * store that reports an empty snapshot with a `no-event-bus` warning; package
   * packs stay unavailable and policy is unchanged.
   */
  readonly events?: Pick<ExtensionAPI["events"], "on" | "emit">;
  /** Called when the snapshot meaningfully changes (collect/clear/out-of-band). */
  readonly onChange?: () => void;
}

/** Issue recorded when the Pi event bus is unavailable. */
const NO_EVENT_BUS_ISSUE: PackageRegistrationIssue = {
  severity: "warning",
  code: "no-event-bus",
  path: "event",
  message:
    "Pi event bus is unavailable; package packs are unavailable until a Pi version with pi.events is used.",
};

/**
 * Build a package registration store bound to a Pi event bus.
 *
 * The register-event listener is installed before this function returns, so a
 * contributor that responds synchronously to the first request is captured
 * even if it registered its request listener after the store was constructed
 * (as long as that happens before the first {@link PackageRegistrationStore.collect}).
 */
export function createPackageRegistrationStore(
  input: CreatePackageRegistrationStoreInput,
): PackageRegistrationStore {
  const events = input.events;
  const onChange = input.onChange;

  // Absent event-bus fallback: an inert store. Package packs remain
  // unavailable and policy behavior is unchanged. collect/clear are safe
  // no-ops and never fire onChange (the snapshot never actually changes).
  if (events === undefined) {
    const inertSnapshot: PackageRegistrationSnapshot = {
      requestId: null,
      packs: [],
      issues: [NO_EVENT_BUS_ISSUE],
    };
    return {
      snapshot: () => inertSnapshot,
      collect: () => inertSnapshot,
      clear: () => {
        /* no event bus: nothing to clear */
      },
      dispose: () => {
        /* no event bus: no listener to dispose */
      },
    };
  }

  // Capture the narrowed, non-undefined bus so closures (collect/handler)
  // see a definite type rather than the optional parameter.
  const bus = events;

  let packs: NormalizedPackagePack[] = [];
  let issues: PackageRegistrationIssue[] = [];
  let currentRequestId: string | null = null;
  // Monotonic counter for deterministic, unique-within-instance request ids.
  // v1 contributors respond synchronously within the request emit, so a
  // per-instance counter is sufficient to distinguish fresh from stale
  // responses; it also keeps snapshots deterministic for tests. Cross-instance
  // collisions from async contributors are an accepted v1 edge case (see the
  // parent feature's "async registration ambiguity" risk note).
  let requestCounter = 0;
  // True while a collect() is driving synchronous responses. Suppresses
  // per-registration onChange so collect fires it exactly once at the end;
  // out-of-band (unsolicited) registrations still notify.
  let isCollecting = false;
  let disposed = false;

  function resetState(): void {
    packs = [];
    issues = [];
    currentRequestId = null;
  }

  function notify(): void {
    onChange?.();
  }

  // Register-event listener. Classifies each incoming payload by request id:
  // accept unsolicited (no requestId) and current-request responses; warn and
  // ignore stale responses for older request ids. The normalizer is total, so
  // this handler never throws on payload shape. The unsubscribe handle is kept
  // so `session_shutdown` can detach this store from Pi's persistent event bus.
  const unsubscribeRegister = bus.on(
    AUTO_REVIEWER_PACKS_REGISTER_EVENT,
    (data: unknown) => {
      if (disposed) {
        return;
      }

      const rawRequestId = readRequestId(data);

      if (rawRequestId !== undefined && rawRequestId !== currentRequestId) {
        // Stale: a response for a request we are no longer servicing (e.g. an
        // older request id after reload). Record a warning and contribute
        // nothing, so stale data can never widen available packs.
        issues.push({
          severity: "warning",
          code: "stale-registration",
          path: "event",
          message: buildStaleMessage(rawRequestId, currentRequestId),
        });
        if (!isCollecting) {
          notify();
        }
        return;
      }

      // Accept: matches the current request id, or unsolicited (no request id).
      // Unsolicited registrations support manual tests and contributors that
      // emit during their own session_start.
      const result = normalizePackagePackRegistration(data);
      for (const pack of result.packs) {
        packs.push(pack);
      }
      for (const issue of result.issues) {
        issues.push(issue);
      }
      if (!isCollecting) {
        notify();
      }
    },
  );

  function collect(
    reason: PackageRegistrationCollectReason,
  ): PackageRegistrationSnapshot {
    if (disposed) {
      return snapshot();
    }

    resetState();
    requestCounter += 1;
    const requestId = `pi-auto-approve:packs:request:${requestCounter}`;
    currentRequestId = requestId;

    const request: AutoReviewerPackRegistrationRequest = {
      apiVersion: AUTO_REVIEWER_PACK_REGISTRATION_API_VERSION,
      requestId,
      reason,
    };

    // Synchronous capture: contributors respond inside this emit (their
    // register-event emits are delivered to the listener above before emit
    // returns). Wrap in try/catch so a contributor handler error surfaced by
    // the bus becomes an issue rather than aborting startup. (Pi's own event
    // bus swallows handler errors, so this is a safety net for buses/tests
    // that surface them.)
    isCollecting = true;
    try {
      bus.emit(AUTO_REVIEWER_PACKS_REQUEST_EVENT, request);
    } catch (error) {
      issues.push({
        severity: "error",
        code: "collection-error",
        path: "event",
        message: `package registration request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    } finally {
      isCollecting = false;
    }

    notify();
    return snapshot();
  }

  function clear(): void {
    if (disposed) {
      return;
    }

    resetState();
    notify();
  }

  function dispose(): void {
    if (disposed) {
      return;
    }

    disposed = true;
    unsubscribeRegister();
    resetState();
  }

  function snapshot(): PackageRegistrationSnapshot {
    return {
      requestId: currentRequestId,
      packs: [...packs],
      issues: [...issues],
    };
  }

  return { snapshot, collect, clear, dispose };
}

/**
 * Read the `requestId` field from a raw registration payload. Returns
 * `undefined` for non-string values so a malformed/non-string requestId is
 * treated as unsolicited (the normalizer then validates the rest of the
 * payload and may record its own issues).
 */
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
    ? `Ignoring package registration for request id "${rawRequestId}" (no active collection).`
    : `Ignoring package registration for stale request id "${rawRequestId}" (current "${currentRequestId}").`;
}
