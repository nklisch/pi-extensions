/**
 * A deliberately tiny custody wrapper. It has no getter: callers can only
 * hand the plaintext to the one operation that immediately consumes it.
 * Native private storage and redacted coercions keep accidental diagnostics
 * from turning a secret into a durable value.
 */
const plaintextByValue = new WeakMap<SensitiveValue, string>();

export class SensitiveValue {
  #plaintext: string;

  private constructor(plaintext: string) {
    this.#plaintext = plaintext;
    plaintextByValue.set(this, plaintext);
    Object.freeze(this);
  }

  static fromUnknown(input: unknown): SensitiveValue {
    if (input instanceof SensitiveValue) return input;
    if (typeof input === "string") return new SensitiveValue(input);
    if (typeof input === "number" && Number.isFinite(input)) return new SensitiveValue(String(input));
    if (typeof input === "boolean") return new SensitiveValue(String(input));
    if (Array.isArray(input) && input.every((value) => typeof value === "string")) {
      return new SensitiveValue(JSON.stringify(input));
    }
    throw new TypeError("sensitive value must be a string, finite number, boolean, or string array");
  }

  toString(): "[REDACTED]" {
    return "[REDACTED]";
  }

  toJSON(): "[REDACTED]" {
    return "[REDACTED]";
  }

  [Symbol.toPrimitive](): "[REDACTED]" {
    return "[REDACTED]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): "[REDACTED]" {
    return "[REDACTED]";
  }
}

export function withSensitiveValue<T>(
  value: SensitiveValue,
  consume: (plaintext: string) => T,
): T {
  if (!(value instanceof SensitiveValue)) throw new TypeError("withSensitiveValue requires SensitiveValue");
  const plaintext = plaintextByValue.get(value);
  if (plaintext === undefined) throw new TypeError("sensitive value is not valid");
  return consume(plaintext);
}
