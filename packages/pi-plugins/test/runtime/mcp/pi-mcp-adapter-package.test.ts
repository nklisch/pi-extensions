import { describe, expect, it, vi } from "vitest";
import { probePublishedPackage } from "../../../src/runtime/published-package-receipt.js";
import { createVerifiedPiMcpRuntimeCandidate } from "../../../src/runtime/mcp/pi-mcp-adapter-package.js";

vi.mock("../../../src/runtime/published-package-receipt.js", () => ({
  probePublishedPackage: vi.fn(),
}));

const probe = vi.mocked(probePublishedPackage);

describe("verified MCP runtime candidate", () => {
  it("turns a receipt mismatch into a structured safe outcome", async () => {
    probe.mockResolvedValue({ kind: "unavailable", code: "PACKAGE_DRIFT" });

    await expect(createVerifiedPiMcpRuntimeCandidate()).resolves.toEqual({
      kind: "unavailable",
      code: "PACKAGE_DRIFT",
      explanation: "The installed MCP adapter package does not match the required release.",
    });
  });

  it("keeps import causes internal while returning a short safe detail", async () => {
    probe.mockResolvedValue({
      kind: "verified",
      packageRoot: "/unused",
      entry: "data:text/javascript,export default {}",
    });

    const result = await createVerifiedPiMcpRuntimeCandidate();
    expect(result).toMatchObject({
      kind: "unavailable",
      code: "PACKAGE_IMPORT_FAILED",
      explanation: "The MCP adapter package does not expose a usable programmatic runtime.",
    });
    expect(result).toHaveProperty("cause");
    expect(JSON.stringify({ code: result.code, explanation: result.explanation })).not.toContain("TypeError");
  });
});
