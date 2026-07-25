import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeProjectIntentBytes, encodeProjectIntentDeclaration } from "../../src/application/project-intent-codec.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

describe("project intent codec", () => {
  it("sorts declarations deterministically and emits one canonical newline", () => {
    const declaration = {
      schemaVersion: 1 as const,
      marketplaces: [
        { marketplace: "zeta", source: { kind: "github" as const, repository: "owner/zeta" } },
        { marketplace: "alpha", source: { kind: "github" as const, repository: "owner/alpha" } },
      ],
      plugins: [
        { plugin: "z@zeta", enabled: false },
        { plugin: "a@alpha", enabled: true },
      ],
    };
    const encoded = encodeProjectIntentDeclaration(declaration, sha256);
    const reversed = encodeProjectIntentDeclaration({ ...declaration, marketplaces: [...declaration.marketplaces].reverse(), plugins: [...declaration.plugins].reverse() }, sha256);
    expect(encoded.bytes).toEqual(reversed.bytes);
    expect(new TextDecoder().decode(encoded.bytes).endsWith("\n")).toBe(true);
    expect(decodeProjectIntentBytes(encoded.bytes, sha256)).toMatchObject({ kind: "decoded", digest: encoded.digest });
  });

  it("rejects invalid UTF-8, schema, and machine-local leakage", () => {
    expect(decodeProjectIntentBytes(new Uint8Array([0xff]), sha256)).toEqual({ kind: "invalid", code: "FILE_INVALID_UTF8" });
    expect(decodeProjectIntentBytes(new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, marketplaces: [], plugins: [], trust: "yes" })), sha256)).toEqual({ kind: "invalid", code: "FILE_INVALID" });
    expect(() => encodeProjectIntentDeclaration({ schemaVersion: 1, marketplaces: [], plugins: [], root: "/private" } as never, sha256)).toThrow();
  });
});
