import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

/**
 * Pure content-block manipulation for assistant messages — extracted from
 * the extension wiring so the replacement/restoration logic is unit-testable
 * without a pi session.
 */

type Content = AssistantMessage["content"];

/**
 * Per-text-block restoration record, keyed by content-array index.
 * `original` is the FULL original block (including provider metadata such as
 * textSignature, which is only valid paired with the original text).
 * `rewritten` is the displayed text, used as a guard so restoration only
 * fires on the exact block we replaced — not on a colliding timestamp or a
 * block the user/session has since edited.
 */
export interface BlockRecord {
  original: TextContent;
  rewritten: string;
}

export type BlockOriginals = Map<number, BlockRecord>;

/** Indexes of non-whitespace text blocks, in content order. */
export function textBlockIndexes(content: Content): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block.type === "text" && block.text.trim().length > 0) indexes.push(i);
  }
  return indexes;
}

/**
 * Swap rewritten text into a copy of `content`, keeping every block in its
 * original position (so interleaved tool calls stay put). The displayed
 * block drops `textSignature`: that provider metadata was generated for the
 * original text and pairing it with rewritten text can confuse
 * signature-sensitive providers. Returns the new content array plus the
 * per-block restoration records; blocks without a rewrite are untouched.
 */
export function applyRewrites(
  content: Content,
  rewrites: ReadonlyMap<number, string>,
): { content: Content; originals: BlockOriginals } {
  const originals: BlockOriginals = new Map();
  const next = [...content];
  for (const [index, text] of rewrites) {
    const block = content[index];
    if (block === undefined || block.type !== "text") continue;
    const original = block as TextContent;
    originals.set(index, { original, rewritten: text });
    const { textSignature: _dropped, ...unsigned } = original;
    next[index] = { ...unsigned, text };
  }
  return { content: next, originals };
}

/**
 * Restore stashed original blocks into a message content array (the deep
 * copy handed to the `context` hook, or compaction preparation messages).
 * A block is restored only when its current text still matches the rewrite
 * we placed — anything else means the message changed underneath us and
 * restoring would corrupt it.
 */
export function restoreOriginals(content: Content, originals: BlockOriginals): void {
  for (const [index, record] of originals) {
    const block = content[index];
    if (block !== undefined && block.type === "text" && block.text === record.rewritten) {
      content[index] = { ...record.original };
    }
  }
}

/**
 * Compaction-safe variant of restoration: pi's compaction preparation
 * arrays ALIAS the live session entry objects, so restoring in place would
 * leak originals into the live session if compaction is cancelled, forked,
 * or exported. Returns a NEW array in which restored messages are clones;
 * untouched messages keep their identity. Callers splice the result back
 * into the (throwaway) preparation array.
 */
export function restoredClones<M extends { role: string; timestamp: number }>(
  messages: readonly M[],
  originalsByTimestamp: ReadonlyMap<number, BlockOriginals>,
): M[] {
  if (originalsByTimestamp.size === 0) return [...messages];
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const blocks = originalsByTimestamp.get(message.timestamp);
    if (blocks === undefined) return message;
    const clone = structuredClone(message) as M & { content: Content };
    restoreOriginals(clone.content, blocks);
    return clone;
  });
}
