import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const CLEARANCE_ALLOW_REQUEST_CUSTOM_TYPE = "clearance.allow-request";

export interface ClearanceAllowRequestDetails {
  readonly brief: string;
  readonly form: "free-text" | "recent-command" | "no-recent-command";
}

/**
 * Keep the transcript row compact while the custom message content remains the
 * complete, clearly labelled brief that Pi sends to the model. The renderer is
 * deliberately not the source of model context.
 */
export const renderClearanceAllowRequest: MessageRenderer<
  ClearanceAllowRequestDetails
> = (message) => {
  const form = readAllowRequestForm(message);
  return new Text(`[Pi Clearance] Allow request handed to agent (${form})`);
};

function readAllowRequestForm(message: unknown):
  | ClearanceAllowRequestDetails["form"]
  | "request" {
  try {
    if (!isRecord(message)) return "request";
    const details = message.details;
    if (!isRecord(details)) return "request";
    const form = details.form;
    return isAllowRequestForm(form) ? form : "request";
  } catch (error) {
    // Message details come from the persisted/custom-message boundary. A
    // hostile getter must degrade the transcript row, not escape the renderer.
    console.error(
      `Pi Clearance allow-request details validation failed: ${errorMessage(error)}`,
    );
    return "request";
  }
}

function isAllowRequestForm(value: unknown): value is ClearanceAllowRequestDetails["form"] {
  return (
    value === "free-text" ||
    value === "recent-command" ||
    value === "no-recent-command"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}
