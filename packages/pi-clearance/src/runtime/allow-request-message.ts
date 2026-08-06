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
  const form = message.details?.form ?? "request";
  return new Text(`[Pi Clearance] Allow request handed to agent (${form})`);
};
