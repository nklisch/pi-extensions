import { z } from "zod";
import { hashContent } from "../domain/content-manifest.js";
import { MarketplaceCursorSchema, type MarketplaceCursor } from "../domain/marketplace-registration.js";
import type { MarketplaceCandidateSummary } from "./marketplace-catalog-contract.js";
import { MarketplaceCatalogError } from "./marketplace-catalog-contract.js";
import type { Sha256 } from "../domain/source.js";
import { codePointCompare } from "./marketplace-state.js";

export type MarketplaceSortTuple = readonly [
  scope: "user" | "project",
  marketplace: string,
  name: string,
  version: string,
  candidateId: string,
];

export type SearchableMarketplaceCandidate = Readonly<{
  summary: MarketplaceCandidateSummary;
  safeSearchValues: readonly string[];
  sort: MarketplaceSortTuple;
}>;

const CursorPayloadSchema = z.object({
  version: z.literal(1),
  queryHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  snapshotHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  last: z.tuple([z.enum(["user", "project"]), z.string(), z.string(), z.string(), z.string()]).readonly(),
}).strict().readonly();
type CursorPayload = z.infer<typeof CursorPayloadSchema>;

function canonicalText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function normalizeMarketplaceQuery(query: string): readonly string[] {
  if (typeof query !== "string" || [...query].length > 256) throw new MarketplaceCatalogError("QUERY_INVALID");
  const normalized = canonicalText(query);
  if (normalized.length === 0) return [];
  const tokens = normalized.split(" ");
  if (tokens.length > 16) throw new MarketplaceCatalogError("QUERY_INVALID");
  return tokens;
}

export function candidateMatches(candidate: SearchableMarketplaceCandidate, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = canonicalText(candidate.safeSearchValues.join(" "));
  return tokens.every((token) => haystack.includes(token));
}

export function compareMarketplaceSortTuple(left: MarketplaceSortTuple, right: MarketplaceSortTuple): number {
  if (left[0] !== right[0]) return left[0] === "user" ? -1 : 1;
  for (let index = 1; index < left.length; index += 1) {
    const difference = codePointCompare(left[index]!, right[index]!);
    if (difference !== 0) return difference;
  }
  return 0;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new MarketplaceCatalogError("CURSOR_INVALID");
  const padding = "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  } catch {
    throw new MarketplaceCatalogError("CURSOR_INVALID");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function queryFingerprint(value: unknown, sha256: Sha256): string {
  return hashContent(new TextEncoder().encode(JSON.stringify(value)), sha256);
}

export function encodeMarketplaceCursor(payload: CursorPayload): MarketplaceCursor {
  const parsed = CursorPayloadSchema.parse(payload);
  return MarketplaceCursorSchema.parse(`marketplace-cursor-v1:${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(parsed)))}`);
}

export function decodeMarketplaceCursor(cursor: MarketplaceCursor): CursorPayload {
  const parsed = MarketplaceCursorSchema.safeParse(cursor);
  if (!parsed.success) throw new MarketplaceCatalogError("CURSOR_INVALID");
  try {
    const encoded = parsed.data.slice("marketplace-cursor-v1:".length);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(encoded));
    return CursorPayloadSchema.parse(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof MarketplaceCatalogError) throw error;
    throw new MarketplaceCatalogError("CURSOR_INVALID");
  }
}

export function paginateMarketplaceCandidates(input: Readonly<{
  candidates: readonly SearchableMarketplaceCandidate[];
  tokens: readonly string[];
  limit: number;
  queryHash: string;
  snapshotHash: string;
  cursor?: MarketplaceCursor;
}>): Readonly<{ candidates: readonly MarketplaceCandidateSummary[]; nextCursor?: MarketplaceCursor }> {
  const ordered = input.candidates.filter((candidate) => candidateMatches(candidate, input.tokens))
    .sort((left, right) => compareMarketplaceSortTuple(left.sort, right.sort));
  let start = 0;
  if (input.cursor !== undefined) {
    const cursor = decodeMarketplaceCursor(input.cursor);
    if (cursor.queryHash !== input.queryHash || cursor.snapshotHash !== input.snapshotHash) throw new MarketplaceCatalogError("CURSOR_STALE");
    start = ordered.findIndex((candidate) => compareMarketplaceSortTuple(candidate.sort, cursor.last) > 0);
    if (start < 0) start = ordered.length;
  }
  const page = ordered.slice(start, start + input.limit);
  const hasMore = start + page.length < ordered.length;
  const last = page.at(-1)?.sort;
  return {
    candidates: page.map((candidate) => candidate.summary),
    ...(hasMore && last !== undefined ? {
      nextCursor: encodeMarketplaceCursor({ version: 1, queryHash: input.queryHash, snapshotHash: input.snapshotHash, last }),
    } : {}),
  };
}
