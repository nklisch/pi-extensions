import { describe, expect, it } from "vitest";
import { projectTerminalText } from "../../../src/pi/manager/pi-terminal-text.js";

const controls = ["\u001b[31mred", "\u001b]52;c;secret\u0007", "a\u0000b", "x\u0085y", "left\u202eright", "x\u2066y", "line\nnext", "tab\tstop", "\ud800"];

describe("Pi terminal text projection", () => {
  it.each(controls)("removes terminal-structural scalar %j", (value) => {
    const projected = projectTerminalText(value, 128);
    expect(projected.text).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u);
    expect(projected.text).not.toContain("\u001b");
  });

  it("truncates by Unicode scalar without splitting wide input", () => {
    expect(projectTerminalText("界界界界", 3)).toEqual({ text: "界界…", escaped: false, truncated: true });
    expect(projectTerminalText("plain", 10)).toEqual({ text: "plain", escaped: false, truncated: false });
  });
});
