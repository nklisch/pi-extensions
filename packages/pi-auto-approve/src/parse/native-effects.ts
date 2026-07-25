import {
  type NativeEffectCondition,
  requireNativeEngine,
} from "../native/loader.ts";
import type { BashStage, BashStageProgram } from "./shape.ts";

export const EFFECT_CLASSES = Object.freeze([
  "read-only",
  "write",
  "destructive",
  "network",
  "shell-wrap",
  "unknown",
] as const);
export type EffectClass = (typeof EFFECT_CLASSES)[number];

export interface EffectClassification {
  readonly class: EffectClass;
  readonly reason: string;
}

export type EffectCondition = NativeEffectCondition;
export type FileInputSpec =
  | { readonly kind: "none" }
  | { readonly kind: "positional"; readonly mode: "all" | "program-specific" };
export interface EffectRegistryEntry {
  readonly program: string;
  readonly class: EffectClass;
  readonly condition?: EffectCondition;
  readonly fileInputs?: FileInputSpec;
  readonly reason: string;
}

/** Native data table consumed by pack authoring, never reimplemented in TS. */
export const EFFECT_REGISTRY: readonly EffectRegistryEntry[] = Object.freeze(
  requireNativeEngine().effectRegistry() as readonly EffectRegistryEntry[],
);

export function classifyStageEffect(stage: BashStage): EffectClassification {
  return requireNativeEngine().classifyStageEffect(stage);
}

export function getStageFileInputArgIndices(
  stage: BashStage,
): readonly number[] {
  return requireNativeEngine().stageFileInputIndices(stage);
}

export type { BashStageProgram };
