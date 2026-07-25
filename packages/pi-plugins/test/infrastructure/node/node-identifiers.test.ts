import { describe, expect, it } from "vitest";
import { ConfigurationWriteIdSchema } from "../../../src/domain/configured-values.js";
import { RefreshClaimIdSchema } from "../../../src/domain/update-policy.js";
import { LifecycleOperationIdSchema } from "../../../src/application/ports/lifecycle-operation-id.js";
import { createNodeHostIdentifiers } from "../../../src/infrastructure/node/node-identifiers.js";
import { createNodeLifecycleClock } from "../../../src/infrastructure/node/node-lifecycle-clock.js";

describe("Node host identifiers and clock", () => {
  it("issues schema-valid unpredictable process-safe identifiers", async () => {
    const ids = createNodeHostIdentifiers();
    const signal = new AbortController().signal;
    const operations = await Promise.all(Array.from({ length: 20 }, () => ids.operationIds.create(signal)));
    const writes = await Promise.all(Array.from({ length: 20 }, () => ids.configurationWriteIds.create(signal)));
    const claims = await Promise.all(Array.from({ length: 20 }, () => ids.refreshClaimIds.create()));
    expect(new Set(operations).size).toBe(20);
    expect(new Set(writes).size).toBe(20);
    expect(new Set(claims).size).toBe(20);
    operations.forEach((value) => LifecycleOperationIdSchema.parse(value));
    writes.forEach((value) => ConfigurationWriteIdSchema.parse(value));
    claims.forEach((value) => RefreshClaimIdSchema.parse(value));
  });

  it("aborts before issuance and shares one inert clock", async () => {
    const ids = createNodeHostIdentifiers();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(ids.operationIds.create(controller.signal)).rejects.toThrow("cancelled");
    await expect(ids.configurationWriteIds.create(controller.signal)).rejects.toThrow("cancelled");
    expect(createNodeLifecycleClock()).toBe(createNodeLifecycleClock());
    expect(createNodeLifecycleClock().nowEpochMilliseconds()).toBeGreaterThan(0);
    expect(createNodeLifecycleClock().monotonicMilliseconds()).toBeGreaterThanOrEqual(0);
  });
});
