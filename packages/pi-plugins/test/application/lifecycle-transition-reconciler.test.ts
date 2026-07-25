import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInactiveProjectionExpectation } from "../../src/application/ports/runtime-projection.js";
import { CurrentProjectRuntimeContextSchema } from "../../src/application/ports/project-trust.js";
import { projectionMatchesObservation } from "../../src/application/recovery-contract.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

describe("lifecycle transition reconciliation evidence", () => {
  it("requires exact scope and plugin evidence instead of treating reload acceptance as proof", () => {
    const expectation = createInactiveProjectionExpectation({ scope: { kind: "user" }, plugin: "demo@community" as never, sha256 });
    const currentProject = CurrentProjectRuntimeContextSchema.parse({
      identity: { kind: "path-only", canonicalRoot: "file:///workspace/", limitation: "identity-changes-with-canonical-root" },
      projectKey: `project-v1:sha256:${"1".repeat(64)}`,
      trust: { kind: "trusted" },
    });
    expect(projectionMatchesObservation({ kind: "inactive", scope: { kind: "user" }, plugin: "demo@community" as never, projectionDigest: expectation.digest, currentProject }, expectation, "demo@community" as never)).toBe(true);
    expect(projectionMatchesObservation({ kind: "inactive", scope: { kind: "user" }, plugin: "other@community" as never, projectionDigest: expectation.digest, currentProject }, expectation, "demo@community" as never)).toBe(false);
  });
});
