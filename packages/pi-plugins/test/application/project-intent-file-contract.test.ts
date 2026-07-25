import { describe, expect, it } from "vitest";
import { ProjectIntentWriteIdSchema } from "../../src/application/ports/project-intent-write-id.js";

describe("project intent file contract", () => {
  it("accepts only unpredictable fixed-shape write identifiers", () => {
    expect(ProjectIntentWriteIdSchema.safeParse(`project-intent-write-v1:${"A".repeat(32)}`).success).toBe(true);
    expect(ProjectIntentWriteIdSchema.safeParse("../plugins.json").success).toBe(false);
    expect(ProjectIntentWriteIdSchema.safeParse(`project-intent-write-v1:${"A".repeat(33)}`).success).toBe(false);
  });
});
