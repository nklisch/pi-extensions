import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createContentManifest,
  createMaterializationBinding,
  hashContent,
} from "../../src/domain/content-manifest.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import {
  assertVerifiedPromotionPlan,
  createPromotionPlan,
  isVerifiedPromotionPlan,
} from "../../src/application/content-promotion.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const content = createContentManifest([{
  kind: "file",
  path: "plugin.txt",
  mode: 0o644,
  size: 4,
  digest: hashContent(new TextEncoder().encode("test"), sha256),
}], sha256);
const source = createResolvedPluginSource({
  kind: "git",
  url: "https://example.com/plugin.git",
  revision: "a".repeat(40),
}, sha256);
const allocation = Object.freeze({
  slot: Object.freeze({ root: "/private/staging/one" }),
  allocationId: "opaque-token",
});
const handoff = {
  root: "/private/staging/one/content",
  source,
  content,
  binding: createMaterializationBinding(source.hash, content.rootDigest, sha256),
} as const;

describe("promotion plan application contract", () => {
  it("creates a frozen, identity-bound plan", () => {
    const plan = createPromotionPlan({ kind: "plugin", allocation, materialized: handoff }, sha256);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(isVerifiedPromotionPlan(plan)).toBe(true);
    expect(assertVerifiedPromotionPlan(plan, sha256)).toBe(plan);
    expect(plan.identity.kind).toBe("plugin");
  });

  it("does not accept structural plan or handoff forgery", () => {
    const plan = createPromotionPlan({ kind: "plugin", allocation, materialized: handoff }, sha256);
    expect(isVerifiedPromotionPlan({ ...plan })).toBe(false);
    expect(() => assertVerifiedPromotionPlan({ ...plan }, sha256)).toThrow(/capability/);
    expect(() => createPromotionPlan({
      kind: "plugin",
      allocation,
      materialized: { ...handoff, binding: `sha256:${"0".repeat(64)}` },
    }, sha256)).toThrow(/binding/);
  });
});
