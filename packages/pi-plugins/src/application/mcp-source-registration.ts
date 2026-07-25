import { canonicalJson } from "../domain/canonical-json.js";
import { hashContent, type ContentDigest } from "../domain/content-manifest.js";
import { DomainContractError, ErrorCodeRegistry } from "../domain/errors.js";
import type { Sha256 } from "../domain/source.js";
import {
  McpConfigSourceSchemaV1,
  McpSourceRegistrationSchemaV1,
  type McpConfigSource,
  type McpSourceRegistration,
} from "./ports/mcp-runtime.js";

const encoder = new TextEncoder();
const OPERATION = "createMcpSourceRegistration";

function registrationDigest(
  source: McpConfigSource,
  sha256: Sha256,
): ContentDigest {
  return hashContent(
    encoder.encode(`mcp-source-registration-v1\0${canonicalJson(source)}`),
    sha256,
  );
}

function invalidRegistration(reason: string): never {
  throw new DomainContractError({
    code: ErrorCodeRegistry.sourceInvalid,
    operation: OPERATION,
    message: "MCP source registration evidence is inconsistent",
    details: { reason },
  });
}

/** Bind the exact canonical, secret-free source bytes to one digest. */
export function createMcpSourceRegistration(input: Readonly<{
  source: McpConfigSource;
  sha256: Sha256;
  digest?: ContentDigest;
}>): McpSourceRegistration {
  let source: McpConfigSource;
  try {
    if (typeof input.sha256 !== "function") throw new Error("missing digest function");
    source = McpConfigSourceSchemaV1.parse(input.source);
  } catch {
    invalidRegistration("INVALID_SOURCE");
  }
  const digest = registrationDigest(source, input.sha256);
  if (input.digest !== undefined && input.digest !== digest) {
    invalidRegistration("DIGEST_MISMATCH");
  }
  return McpSourceRegistrationSchemaV1.parse({
    schemaVersion: 1,
    source,
    digest,
  });
}

/** Parse untrusted registration evidence and recompute its canonical digest. */
export function verifyMcpSourceRegistration(
  input: unknown,
  sha256: Sha256,
): McpSourceRegistration {
  let registration: McpSourceRegistration;
  try {
    registration = McpSourceRegistrationSchemaV1.parse(input);
  } catch {
    invalidRegistration("INVALID_REGISTRATION");
  }
  return createMcpSourceRegistration({
    source: registration.source,
    digest: registration.digest,
    sha256,
  });
}
