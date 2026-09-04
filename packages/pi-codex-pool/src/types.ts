import type { Model, Provider, SimpleStreamOptions, Context, AssistantMessageEventStream, OAuthCredential, ApiStreamOptions } from "@earendil-works/pi-ai";

export const FIVE_HOUR_WINDOW_SECONDS = 18_000;
export const WEEKLY_WINDOW_SECONDS = 604_800;
export const DEFAULT_THRESHOLD = 10;
export const MAX_LABEL_LENGTH = 32;

export type QuotaSnapshot = {
  fiveHour: number | null;
  weekly: number | null;
  capturedAt: number;
};

export type AccountRecord = {
  id: string;
  label: string;
  providerAccountId: string;
  credentials: OAuthCredential;
  quota?: QuotaSnapshot;
  quotaFailed?: boolean;
  lastError?: string;
};

export type PoolState = {
  accounts: AccountRecord[];
  thresholds: {
    fiveHour: number;
    weekly: number;
  };
  activeAccountId?: string;
};

export type NativeCodexProvider = Provider<"openai-codex-responses"> & {
  auth: NonNullable<Provider["auth"]>;
};

export type CodexStream = (
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type CodexFullStreamOptions = ApiStreamOptions<"openai-codex-responses">;

export type CodexFullStream = (
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: CodexFullStreamOptions,
) => AssistantMessageEventStream;

export type SessionStatusSink = {
  publish(state: PoolState): void;
  revoke(): void;
};
