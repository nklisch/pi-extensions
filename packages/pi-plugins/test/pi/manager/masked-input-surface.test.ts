import { describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { withSensitiveValue } from "../../../src/application/sensitive-value.js";
import { MaskedInputSurface } from "../../../src/pi/manager/masked-input-surface.js";

function create() {
  const done = vi.fn();
  const theme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, bold: (text: string) => text } as any;
  const keybindings = {
    matches: (data: string, id: string) => id.includes("cancel") || id === "app.interrupt" ? matchesKey(data, Key.escape) : id.includes("confirm") ? matchesKey(data, Key.enter) : false,
  } as any;
  const overlay = new MaskedInputSurface({ theme, keybindings, label: "API token", done });
  overlay.focused = true;
  return { overlay, done };
}

describe("masked secret surface", () => {
  it("accepts editing and bracketed paste without rendering or retaining plaintext output", () => {
    const canary = "SECRET-CANARY-界";
    const { overlay, done } = create();
    overlay.handleInput(`\u001b[200~${canary}\u001b[201~`);
    const rendered = overlay.render(40).join("\n");
    expect(rendered).not.toContain(canary);
    expect(rendered).toContain(CURSOR_MARKER);
    expect(visibleWidth(rendered)).toBeLessThanOrEqual(80);
    overlay.handleInput("\u001b[D");
    overlay.handleInput("\u007f");
    overlay.handleInput("\r");
    const value = done.mock.calls[0]![0];
    expect(value.kind).toBe("supplied");
    expect(withSensitiveValue(value.value, (plaintext) => plaintext)).toBe("SECRET-CANARY界");
    expect(overlay.render(40)).toEqual([]);
  });

  it("cancels and disposes idempotently without exposing a getter/copy/yank route", () => {
    const { overlay, done } = create();
    overlay.handleInput("top-secret");
    overlay.handleInput("\u001b");
    expect(done).toHaveBeenCalledWith({ kind: "cancelled" });
    expect(overlay).not.toHaveProperty("getValue");
    overlay.dispose();
    overlay.dispose();
    expect(overlay.render(20)).toEqual([]);
  });
});
