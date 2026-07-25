import { requireNativeEngine } from "../native/loader.ts";
import type {
  MutationTrustBoundaryClassification,
  PathFactProjectScope,
} from "./shape.ts";

export interface MutationTrustBoundaryContext {
  readonly projectScope: PathFactProjectScope;
  readonly homeDirectory?: string;
}

export function classifyMutationTrustBoundary(
  absolutePath: string | undefined,
  context: MutationTrustBoundaryContext,
): MutationTrustBoundaryClassification {
  return requireNativeEngine().classifyMutationTrustBoundary(
    absolutePath,
    context,
  );
}
