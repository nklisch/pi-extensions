export type SettingsActionId =
  | "mode.set"
  | "reviewer.open"
  | "reviewer.model"
  | "reviewer.prompt-append"
  | "reviewer.prompt-override.set"
  | "reviewer.prompt-override.clear"
  | "scope.open"
  | "scope.add-path"
  | "scope.remove-path"
  | "scope.unknown-path"
  | "scope.safe-home-defaults"
  | "scope.agent-support-defaults"
  | "scope.preset"
  | "packs.open"
  | "packs.show"
  | "packs.enable"
  | "packs.disable"
  | "briefing.open"
  | "briefing.mode"
  | "briefing.model-label"
  | "briefing.accent";

export interface SettingsAction {
  readonly id: SettingsActionId;
  readonly args: Readonly<Record<string, string | boolean | number | null>>;
}

export const WRITE_ACTION_IDS = [
  "mode.set",
  "reviewer.model",
  "reviewer.prompt-append",
  "reviewer.prompt-override.set",
  "reviewer.prompt-override.clear",
  "scope.add-path",
  "scope.remove-path",
  "scope.unknown-path",
  "scope.safe-home-defaults",
  "scope.agent-support-defaults",
  "scope.preset",
  "packs.enable",
  "packs.disable",
  "briefing.mode",
  "briefing.model-label",
  "briefing.accent",
] as const satisfies readonly SettingsActionId[];

export const DRILL_ACTION_IDS = [
  "reviewer.open",
  "scope.open",
  "packs.open",
  "packs.show",
  "briefing.open",
] as const satisfies readonly SettingsActionId[];

export function isWriteAction(id: SettingsActionId): boolean {
  return (WRITE_ACTION_IDS as readonly SettingsActionId[]).includes(id);
}

export function isDrillAction(id: SettingsActionId): boolean {
  return (DRILL_ACTION_IDS as readonly SettingsActionId[]).includes(id);
}
