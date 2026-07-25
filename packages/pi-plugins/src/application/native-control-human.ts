import { SafeDisplayFieldSchema, type SafeDisplayField } from "./native-inspection-contract.js";
import type { NativeControlEnvelope } from "./native-control-contract.js";

export interface NativeControlHumanProjector {
  render(envelope: NativeControlEnvelope): readonly SafeDisplayField[];
}

/**
 * Human output remains renderer-neutral. It returns only already-safe fields;
 * it never stringifies machine data or native diagnostics.
 */
export function createNativeControlHumanProjector(): NativeControlHumanProjector {
  const projector: NativeControlHumanProjector = {
    render(envelope: NativeControlEnvelope): readonly SafeDisplayField[] {
      return Object.freeze(envelope.human.map((field: SafeDisplayField) => SafeDisplayFieldSchema.parse(field)));
    },
  };
  return Object.freeze(projector);
}
