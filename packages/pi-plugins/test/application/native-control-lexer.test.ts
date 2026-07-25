import { describe, expect, it } from "vitest";
import { lexNativeControlText } from "../../src/application/native-control-lexer.js";

describe("native control lexer", () => {
  it("implements quoting without expansion", () => {
    expect(lexNativeControlText("browse 'alpha beta' --scope=user")).toEqual({ kind: "tokens", tokens: [
      { value: "browse", complete: true },
      { value: "alpha beta", complete: true },
      { value: "--scope=user", complete: true },
    ] });
    expect(lexNativeControlText('browse "$HOME"')).toMatchObject({ kind: "tokens", tokens: [{ value: "browse" }, { value: "$HOME" }] });
    expect(lexNativeControlText("browse *.json")).toMatchObject({ kind: "tokens", tokens: [{ value: "browse" }, { value: "*.json" }] });
  });

  it.each(["\0", "\n", "\u001b", "\u0085", "\u202e", "\u2066", "\ud800"])("rejects hostile scalar %j", (value) => {
    expect(lexNativeControlText(`browse ${value}`)).toMatchObject({ kind: "invalid" });
  });

  it("distinguishes execution from completion partial input", () => {
    expect(lexNativeControlText("browse 'partial", "execute")).toMatchObject({ kind: "invalid", code: "CONTROL_QUOTE_UNTERMINATED" });
    expect(lexNativeControlText("browse 'partial", "complete")).toMatchObject({ kind: "tokens", tokens: [{ value: "browse", complete: true }, { value: "partial", complete: false }] });
    expect(lexNativeControlText("browse \\q")).toMatchObject({ kind: "invalid", code: "CONTROL_ESCAPE_INVALID" });
  });
});
