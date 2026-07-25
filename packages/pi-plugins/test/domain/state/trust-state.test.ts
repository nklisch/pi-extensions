import { describe, expect, it } from "vitest";
import {
  TrustStateDocumentSchema,
  TrustSubjectEvidenceSchema,
  createTrustStateRecord,
} from "../../../src/domain/state/trust-state.js";
import { deriveTrustSubjectRef } from "../../../src/domain/state/references.js";
import { CanonicalSourceSchema } from "../../../src/domain/source.js";
import { ContentDigestSchema } from "../../../src/domain/content-manifest.js";
import { PluginKeySchema } from "../../../src/domain/identity.js";

const sha256 = () => new Uint8Array(32);
const digest = ContentDigestSchema.parse(`sha256:${"00".repeat(32)}`);
const plugin = PluginKeySchema.parse("demo@team");
const source = CanonicalSourceSchema.parse("source-v1|github|repository:15:example/plugins");
const evidence = {
  plugin,
  scope: { kind: "user" as const },
  marketplaceSource: source,
  pluginSource: source,
  immutableRevision: "a".repeat(40),
  executableSurfaceDigest: digest,
};

describe("trust state", () => {
  it("binds a subject to safe source, revision, executable evidence, and scope", () => {
    const record = createTrustStateRecord({ evidence, status: "granted" }, sha256);
    expect(record.subject).toBe(deriveTrustSubjectRef(evidence, sha256));
    expect(record.evidence).toEqual(evidence);
    expect(record).not.toHaveProperty("configuration");
    expect(record).not.toHaveProperty("secret");
  });

  it("does not accept a forged subject or configured value", () => {
    expect(() => createTrustStateRecord({
      subject: "trust-subject-v1:sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      evidence,
      status: "granted",
    }, sha256)).toThrow();
    expect(TrustSubjectEvidenceSchema.safeParse({ ...evidence, configuredValue: "secret" }).success).toBe(false);
  });

  it("rejects duplicate subjects in one independently versioned document", () => {
    const record = createTrustStateRecord({ evidence, status: "granted" }, sha256);
    expect(TrustStateDocumentSchema.safeParse({
      schemaVersion: 1,
      generation: 0,
      records: [record, record],
    }).success).toBe(false);
    expect(TrustStateDocumentSchema.parse({
      schemaVersion: 1,
      generation: 0,
      records: [record],
    })).toEqual({ schemaVersion: 1, generation: 0, records: [record] });
  });
});
