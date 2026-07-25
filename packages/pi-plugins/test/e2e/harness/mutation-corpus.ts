import { E2E_SEED } from "./constants.js";

export type MutationOperator =
  | "unterminated-quote"
  | "duplicate-global-option"
  | "unicode-lookalike"
  | "control-injection"
  | "embedded-nul"
  | "oversized-value"
  | "conflicting-flags"
  | "option-reordering"
  | "token-checksum"
  | "traversal-spelling"
  | "unknown-alias"
  | "random-bounded";

export type MutationVector = Readonly<{
  seed: number;
  caseId: string;
  operator: MutationOperator;
  text: string;
  bytes: number;
  validMutation: false;
  replay: string;
}>;

function xorshift32(state: number): number {
  let value = state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function boundedRandom(state: number, bytes: number): Readonly<{ state: number; text: string }> {
  let next = state;
  let text = "";
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  while (Buffer.byteLength(text) < bytes) {
    next = xorshift32(next);
    text += alphabet[next % alphabet.length];
  }
  while (Buffer.byteLength(text) > bytes) text = text.slice(0, -1);
  return Object.freeze({ state: next, text });
}

const operators: readonly MutationOperator[] = [
  "unterminated-quote", "duplicate-global-option", "unicode-lookalike", "control-injection",
  "embedded-nul", "oversized-value", "conflicting-flags", "option-reordering",
  "token-checksum", "traversal-spelling", "unknown-alias", "random-bounded",
];

export function mutationCorpus(input: Readonly<{
  seed?: number;
  cases?: number;
  maxBytes?: number;
}> = {}): readonly MutationVector[] {
  const seed = input.seed ?? E2E_SEED;
  const cases = input.cases ?? 128;
  const maxBytes = input.maxBytes ?? 8_192;
  if (!Number.isSafeInteger(cases) || cases < 1 || cases > 1_024) throw new TypeError("mutation case count must be 1..1024");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64 || maxBytes > 8_192) throw new TypeError("mutation byte limit must be 64..8192");
  const vectors: MutationVector[] = [];
  let state = seed >>> 0;
  for (let index = 0; index < cases; index += 1) {
    state = xorshift32(state);
    const operator = operators[index % operators.length]!;
    const token = `trusted-install-session-v1:123e4567-e89b-42d3-a456-426614174000.${state.toString(16).padStart(8, "0").repeat(8)}`;
    let text: string;
    switch (operator) {
      case "unterminated-quote": text = `browse \"case-${index}`; break;
      case "duplicate-global-option": text = "--non-interactive --non-interactive status"; break;
      case "unicode-lookalike": text = `statu\u0455-${index}`; break;
      case "control-injection": text = `status\u001b]8;;https://example.invalid\u0007${index}`; break;
      case "embedded-nul": text = `status\u0000${index}`; break;
      case "oversized-value": text = `browse ${"x".repeat(Math.max(1, maxBytes - 7))}`; break;
      case "conflicting-flags": text = "uninstall ghost@missing --scope user --keep-data --delete-data --yes"; break;
      case "option-reordering": text = "browse --limit 0 query --scope nowhere"; break;
      case "token-checksum": text = `operation status ${token}`; break;
      case "traversal-spelling": text = `marketplace add https://example.invalid/%2e%2e/repo-${index} --source-kind git`; break;
      case "unknown-alias": text = `marketplaces magically-refresh-${index}`; break;
      case "random-bounded": {
        const random = boundedRandom(state, 32 + state % 224);
        state = random.state;
        text = random.text;
        break;
      }
    }
    if (Buffer.byteLength(text) > maxBytes) text = Buffer.from(text).subarray(0, maxBytes).toString("utf8");
    const caseId = `seed-${seed.toString(16)}-case-${index.toString().padStart(3, "0")}-${operator}`;
    vectors.push(Object.freeze({
      seed,
      caseId,
      operator,
      text,
      bytes: Buffer.byteLength(text),
      validMutation: false,
      replay: `PI_PLUGIN_HOST_E2E_CASE=${caseId} npm run test:e2e -- test/e2e/fuzz/control-argv-fuzz.e2e.test.ts`,
    }));
  }
  return Object.freeze(vectors);
}

export function mutateOpaqueToken(token: string): readonly Readonly<{ id: string; value: string }>[] {
  const prefix = token.slice(0, token.indexOf(":") + 1);
  return Object.freeze([
    { id: "truncate", value: token.slice(0, -9) },
    { id: "checksum-flip", value: `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}` },
    { id: "prefix-substitution", value: `native-operation-session-v1:${token.slice(token.indexOf(":") + 1)}` },
    { id: "cross-owner", value: token.replace("123e4567", "223e4567") },
    { id: "valid-looking-random", value: `${prefix}423e4567-e89b-42d3-a456-426614174000.${"d".repeat(64)}` },
    { id: "stale-exact", value: token },
  ]);
}
