import { SafeDisplayFieldSchema, type SafeDisplayField } from "./native-inspection-contract.js";
import { isUnsafeDisplayScalar } from "./native-inspection-display-safety.js";

export const NativeDisplayLimits = Object.freeze({
  labelScalars: 256,
  descriptionScalars: 2_048,
  pathScalars: 1_024,
  commandScalars: 4_096,
  argumentScalars: 2_048,
  maxArguments: 256,
  maxProvenance: 256,
} as const);

const MAX_SAFE_TEXT_UNITS = 8_192;

function visibleEscape(codePoint: number): string {
  return `\\u{${codePoint.toString(16).toUpperCase()}}`;
}

/**
 * Escape before serialization so every renderer receives terminal-safe text.
 * Scalar and serialized-output bounds are both enforced: escaped input can be
 * substantially longer than its source and must still fit the public schema.
 */
export function toSafeDisplayField(
  input: string,
  options: Readonly<{ maxScalars: number }>,
): SafeDisplayField {
  if (typeof input !== "string") throw new TypeError("display input must be a string");
  if (!Number.isSafeInteger(options?.maxScalars) || options.maxScalars < 0) {
    throw new TypeError("display scalar limit must be a non-negative safe integer");
  }

  let text = "";
  let escaped = false;
  let truncated = false;
  let scalars = 0;
  for (let index = 0; index < input.length;) {
    if (scalars >= options.maxScalars) {
      truncated = true;
      break;
    }
    const first = input.charCodeAt(index);
    let codePoint: number;
    let width: number;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = input.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        codePoint = ((first - 0xd800) << 10) + second - 0xdc00 + 0x10000;
        width = 2;
      } else {
        codePoint = first;
        width = 1;
        escaped = true;
      }
    } else {
      codePoint = first;
      width = 1;
      if (first >= 0xdc00 && first <= 0xdfff) escaped = true;
    }
    const character = width === 2 ? input.slice(index, index + 2) : input[index]!;
    const projected = isUnsafeDisplayScalar(character, codePoint)
      ? visibleEscape(codePoint)
      : character;
    if (projected !== character) escaped = true;
    if (text.length + projected.length > MAX_SAFE_TEXT_UNITS) {
      truncated = true;
      break;
    }
    text += projected;
    scalars += 1;
    index += width;
  }
  return SafeDisplayFieldSchema.parse({ text, escaped, truncated });
}
