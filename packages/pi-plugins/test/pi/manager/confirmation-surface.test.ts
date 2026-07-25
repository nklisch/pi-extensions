import { describe, expect, it, vi } from "vitest";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { ConfirmationSurface } from "../../../src/pi/manager/confirmation-surface.js";

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as any;
const keybindings = {
  matches: (data: string, id: string) =>
    id === "tui.select.confirm" ? matchesKey(data, Key.enter) :
      id === "tui.select.cancel" || id === "app.interrupt" ? matchesKey(data, Key.escape) :
        id === "tui.select.up" ? matchesKey(data, Key.up) :
          id === "tui.select.down" ? matchesKey(data, Key.down) :
            id === "tui.select.pageUp" ? matchesKey(data, Key.pageUp) :
              id === "tui.select.pageDown" ? matchesKey(data, Key.pageDown) : false,
} as any;

describe("confirmation surface", () => {
  it("confirms with a single enter even when an executable disclosure exists", () => {
    const done = vi.fn();
    const surface = new ConfirmationSurface({
      theme,
      keybindings,
      title: "Update demo@market?",
      lines: ["3 skills · 1 hook · 0 MCP servers"],
      disclosure: Array.from({ length: 30 }, (_, index) => `executable-${index}`),
      height: () => 6,
      done,
    });

    surface.handleInput("\r");
    expect(done).toHaveBeenCalledWith(true);
  });

  it("confirms and cancels with y/n", () => {
    const accepted = vi.fn();
    new ConfirmationSurface({ theme, keybindings, title: "Add plugin?", lines: ["plugin: demo"], done: accepted })
      .handleInput("y");
    expect(accepted).toHaveBeenCalledWith(true);

    const declined = vi.fn();
    new ConfirmationSurface({ theme, keybindings, title: "Add plugin?", lines: ["plugin: demo"], done: declined })
      .handleInput("n");
    expect(declined).toHaveBeenCalledWith(false);
  });

  it("keeps the exact disclosure one space away and scrollable", () => {
    const done = vi.fn();
    const surface = new ConfirmationSurface({
      theme,
      keybindings,
      title: "Update demo@market?",
      lines: ["plugin: demo"],
      disclosure: Array.from({ length: 30 }, (_, index) => `executable-${index}`),
      height: () => 6,
      done,
    });

    expect(surface.render(36).join("\n")).not.toContain("executable-0");
    surface.handleInput(" ");
    expect(surface.render(36).join("\n")).not.toContain("executable-0");

    surface.handleInput("\u001b[6~");
    expect(surface.render(36).join("\n")).toContain("executable-0");
    for (let index = 0; index < 19; index += 1) {
      surface.handleInput("[6~");
      surface.render(36);
    }
    const tail = surface.render(36);
    expect(tail.join("\n")).toContain("executable-29");
    expect(tail.every((line) => visibleWidth(line) <= 36)).toBe(true);
    // Reviewing the disclosure never strands the user: accept is still one key.
    surface.handleInput("y");
    expect(done).toHaveBeenCalledWith(true);
  });

  it("cancels a fresh confirmation without approval", () => {
    const done = vi.fn();
    const surface = new ConfirmationSurface({ theme, keybindings, title: "Delete data", lines: ["plugin: demo"], done });
    surface.handleInput("");
    surface.handleInput("\r");
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(false);
  });
});
