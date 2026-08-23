import { describe, expect, it } from "vitest";

import { renderClearanceAllowRequest } from "../../src/runtime/allow-request-message.ts";

function render(message: unknown): string {
  const component = renderClearanceAllowRequest(
    message as never,
    { expanded: false },
    {} as never,
  );
  if (component === undefined) throw new Error("expected a renderer component");
  return component.render(120).join("\n");
}

describe("clearance allow-request renderer", () => {
  it("renders a validated form label", () => {
    expect(
      render({ details: { form: "recent-command" } }),
    ).toContain("(recent-command)");
  });

  it("falls back for invalid message details", () => {
    expect(render({ details: { form: "unexpected" } })).toContain("(request)");
    expect(render({ details: null })).toContain("(request)");
  });

  it("contains a throwing details getter", () => {
    const message = {};
    Object.defineProperty(message, "details", {
      get() {
        throw new Error("details getter failed");
      },
    });

    expect(() => render(message)).not.toThrow();
    expect(render(message)).toContain("(request)");
  });
});
