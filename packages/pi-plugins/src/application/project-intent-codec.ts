import type { JsonValue } from "../domain/schema.js";
import { ContentDigestSchema, type ContentDigest } from "../domain/content-manifest.js";
import { decodeStateDocument, encodeStateDocument, hashStateDocument } from "../domain/state/codec.js";
import { parsePortableProjectDeclaration, type PortableProjectDeclaration } from "../domain/state/portable-project-declaration.js";
import type { Sha256 } from "../domain/source.js";
import { NativeLifecycleOperationSessionPolicy } from "./native-lifecycle-operation-contract.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const context = (sha256: Sha256) => ({ scope: { kind: "user" as const }, generation: 0 as never, sha256 });

export type ProjectIntentDecodeResult =
  | Readonly<{ kind: "decoded"; declaration: PortableProjectDeclaration; digest: ContentDigest; bytes: Uint8Array }>
  | Readonly<{ kind: "invalid"; code: "FILE_TOO_LARGE" | "FILE_INVALID_UTF8" | "FILE_INVALID" }>;

export function encodeProjectIntentDeclaration(input: PortableProjectDeclaration, sha256: Sha256): Readonly<{
  declaration: PortableProjectDeclaration;
  digest: ContentDigest;
  bytes: Uint8Array;
}> {
  const declaration = parsePortableProjectDeclaration(input);
  if (declaration.marketplaces.length > NativeLifecycleOperationSessionPolicy.maxProjectDeclarations || declaration.plugins.length > NativeLifecycleOperationSessionPolicy.maxProjectDeclarations) {
    throw new RangeError("portable project declaration exceeds the supported declaration count");
  }
  const encoded = encodeStateDocument("portableProject", declaration, context(sha256)) as JsonValue;
  const bytes = encoder.encode(`${JSON.stringify(encoded)}\n`);
  if (bytes.byteLength > NativeLifecycleOperationSessionPolicy.maxProjectIntentBytes) throw new RangeError("portable project declaration is too large");
  return Object.freeze({ declaration, digest: ContentDigestSchema.parse(hashStateDocument(encoded, sha256)), bytes });
}

export function decodeProjectIntentBytes(bytes: Uint8Array, sha256: Sha256): ProjectIntentDecodeResult {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > NativeLifecycleOperationSessionPolicy.maxProjectIntentBytes) return { kind: "invalid", code: "FILE_TOO_LARGE" };
  let text: string;
  try { text = decoder.decode(bytes); }
  catch { return { kind: "invalid", code: "FILE_INVALID_UTF8" }; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { kind: "invalid", code: "FILE_INVALID" }; }
  try {
    const declaration = parsePortableProjectDeclaration(decodeStateDocument("portableProject", parsed, context(sha256)).value);
    if (declaration.marketplaces.length > NativeLifecycleOperationSessionPolicy.maxProjectDeclarations || declaration.plugins.length > NativeLifecycleOperationSessionPolicy.maxProjectDeclarations) return { kind: "invalid", code: "FILE_TOO_LARGE" };
    const canonical = encodeProjectIntentDeclaration(declaration, sha256);
    return { kind: "decoded", declaration: canonical.declaration, digest: canonical.digest, bytes: canonical.bytes };
  } catch {
    return { kind: "invalid", code: "FILE_INVALID" };
  }
}
