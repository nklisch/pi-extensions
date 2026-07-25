/**
 * Command transform registration — v1 event contract.
 *
 * An installed Pi extension that wants to rewrite a `bash` command **after**
 * pi-auto-approve has approved it (so the auto-reviewer still judges the
 * command the agent typed) registers a transform here. This is the
 * load-order-independent coordination channel between the auto-reviewer and a
 * command rewriter such as RTK output compression.
 *
 * ## Why this exists
 *
 * Pi mutates `tool_call` event handlers in load order on a single shared
 * `event.input.command` object, and the bash executor reads `command` from
 * that same object at execution time. So both a reviewer and a rewriter must
 * act in the `tool_call` window on the same field — whoever loads first wins.
 * Without this contract, a rewriter loaded before the reviewer would mutate
 * the command before the reviewer saw it, so the reviewer would judge the
 * *rewritten* form rather than what the agent typed.
 *
 * This contract inverts that: **pi-auto-approve owns the only `tool_call`
 * handler.** It captures the original command up front (the reviewer always
 * sees the original), and on the `allow` branch it runs every registered
 * transform against the original command, then writes the final result back
 * to `event.input.command`. Rewriters register via `pi.events` instead of
 * racing on `tool_call`, so package-vs-global load rank no longer matters.
 *
 * A rewriter registers by listening for
 * {@link AUTO_REVIEWER_TRANSFORMS_REQUEST_EVENT} on the Pi event bus and
 * emitting {@link AUTO_REVIEWER_TRANSFORMS_REGISTER_EVENT} with an
 * {@link AutoReviewerTransformRegistration} payload whose `transform` is an
 * async function. The request is emitted on `session_start` (after all
 * extension factories have loaded, so a contributor that registers during its
 * own factory is captured regardless of load order).
 *
 * ## Safety model
 *
 * - Transforms run **only after** an `allow` decision (deterministic or model
 *   review). A blocked/denied command is never transformed.
 * - A transform returns `{ command }` to replace the command, `{ skipped }`
 *   to opt out for this call, or `{ error }` to fail open (the prior command
 *   runs unchanged).
 * - Transforms compose in registration order: each transform sees the evolving
 *   command (the prior transform's output, or the original for the first).
 *   The final command is what runs. (Composition semantics may evolve; v1
 *   keeps it simple and deterministic.)
 * - The contract is total: `normalizeCommandTransformRegistration` never
 *   throws on adversarial input — a malformed payload contributes nothing and
 *   records an issue.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Stable API version for the v1 command-transform contract. Payloads with a
 * different `apiVersion` are rejected by the normalizer rather than interpreted.
 */
export const AUTO_REVIEWER_TRANSFORMS_API_VERSION = 1 as const;

/**
 * Event the core extension emits on session_start to request transform
 * registrations from contributor extensions.
 */
export const AUTO_REVIEWER_TRANSFORMS_REQUEST_EVENT =
  "pi-auto-approve:transforms:request" as const;

/**
 * Event a contributor emits in response to a request (or unsolicited) carrying
 * an {@link AutoReviewerTransformRegistration} payload.
 */
export const AUTO_REVIEWER_TRANSFORMS_REGISTER_EVENT =
  "pi-auto-approve:transforms:register" as const;

/** Request payload for {@link AUTO_REVIEWER_TRANSFORMS_REQUEST_EVENT}. */
export interface AutoReviewerTransformsRequest {
  readonly apiVersion: 1;
  readonly requestId: string;
  readonly reason: "startup" | "reload" | "manual";
}

/**
 * The transform function a contributor registers. It receives the command
 * (the original for the first transform, or the prior transform's output for
 * later ones) and the extension context, and returns one of:
 * - `{ command }` — replace the command that will run.
 * - `{ skipped }` — opt out for this call; the prior command is preserved.
 * - `{ error }` — fail open; the prior command is preserved and the error is
 *   surfaced to the transform's last-status (the contributor is responsible
 *   for surfacing it, e.g. via a `/rtk`-style status command).
 *
 * The function must be resilient to an abort signal (via `ctx.signal`) and
 * must not throw synchronously; pi-auto-approve wraps calls in try/catch and
 * treats a throw as `{ error }`.
 */
export type CommandTransformFn = (
  command: string,
  ctx: ExtensionContext,
) => Promise<CommandTransformResult>;

/** Result of a single transform invocation. */
export interface CommandTransformResult {
  /** Replacement command. Omit to preserve the prior command. */
  readonly command?: string;
  /** Human-readable reason this transform did not apply. Display only. */
  readonly skipped?: string;
  /** Failure reason. The prior command is preserved. Display only. */
  readonly error?: string;
}

/** Full registration payload for {@link AUTO_REVIEWER_TRANSFORMS_REGISTER_EVENT}. */
export interface AutoReviewerTransformRegistration {
  readonly apiVersion: 1;
  /** Echo the request id when responding to a collect; omit for unsolicited. */
  readonly requestId?: string;
  /** Stable id for the contributor (e.g. "pi-config:rtk-rewrite"). */
  readonly id: string;
  /** Human-readable description shown in status/diagnostics. */
  readonly description?: string;
  /** The transform function. Required. */
  readonly transform: CommandTransformFn;
}

/**
 * A validated transform ready to run. The normalizer attaches a stable id and
 * description; the transform function is the contributor's, unmodified.
 */
export interface NormalizedCommandTransform {
  readonly id: string;
  readonly description: string;
  readonly transform: CommandTransformFn;
}

/** A structured registration issue. */
export interface CommandTransformIssue {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** Result of normalizing a registration payload. */
export interface CommandTransformRegistrationResult {
  readonly transform: NormalizedCommandTransform | null;
  readonly issues: readonly CommandTransformIssue[];
}

/**
 * Normalize an untrusted transform-registration payload into a validated
 * transform (or null) plus structured issues. Total: never throws.
 *
 * A valid payload has `apiVersion === 1`, a non-empty string `id`, and a
 * function `transform`. A missing or non-function `transform` is an error
 * (there is nothing to register without one).
 */
export function normalizeCommandTransformRegistration(
  registration: unknown,
): CommandTransformRegistrationResult {
  try {
    return normalizeRegistration(registration);
  } catch (error) {
    return {
      transform: null,
      issues: [
        {
          severity: "error",
          code: "normalizer-error",
          path: "$",
          message: `normalizer error: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        },
      ],
    };
  }
}

function normalizeRegistration(
  registration: unknown,
): CommandTransformRegistrationResult {
  const issues: CommandTransformIssue[] = [];

  if (!isRecord(registration)) {
    issues.push(
      issue({
        severity: "error",
        code: "invalid-registration",
        path: "$",
        message: "expected registration object",
      }),
    );
    return { transform: null, issues };
  }

  if (registration.apiVersion !== AUTO_REVIEWER_TRANSFORMS_API_VERSION) {
    issues.push(
      issue({
        severity: "error",
        code: "invalid-api-version",
        path: "$.apiVersion",
        message: `expected apiVersion ${AUTO_REVIEWER_TRANSFORMS_API_VERSION}`,
      }),
    );
    // Unknown payload version has undefined semantics; do not interpret it.
    return { transform: null, issues };
  }

  if (!isNonEmptyString(registration.id)) {
    issues.push(
      issue({
        severity: "error",
        code: "missing-id",
        path: "$.id",
        message: "expected non-empty transform id",
      }),
    );
    return { transform: null, issues };
  }

  if (typeof registration.transform !== "function") {
    issues.push(
      issue({
        severity: "error",
        code: "missing-transform",
        path: "$.transform",
        message: "expected transform function",
      }),
    );
    return { transform: null, issues };
  }

  const description =
    typeof registration.description === "string"
      ? registration.description
      : registration.id;

  const normalized: NormalizedCommandTransform = {
    id: registration.id,
    description,
    transform: registration.transform as CommandTransformFn,
  };

  return { transform: normalized, issues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function issue(params: {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}): CommandTransformIssue {
  return { ...params };
}
