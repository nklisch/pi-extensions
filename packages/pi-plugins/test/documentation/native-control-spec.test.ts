import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  NativeControlCommandRegistry,
  type NativeControlCommandDefinition,
  type NativeControlOptionDefinition,
} from "../../src/application/native-control-registry.js";
import { createNativeControlParser } from "../../src/application/native-control-parser.js";

const specUrl = new URL("../../docs/SPEC.md", import.meta.url);

function marked(text: string, name: string): string {
  const match = text.match(new RegExp(`<!-- ${name}:start -->\\n([\\s\\S]*?)\\n<!-- ${name}:end -->`, "u"));
  if (match?.[1] === undefined) throw new Error(`missing ${name} documentation block`);
  return match[1];
}

function optionSyntax(option: NativeControlOptionDefinition): string {
  const value = option.kind === "flag"
    ? option.name
    : option.values !== undefined
      ? `${option.name} ${option.values.join("|")}`
      : option.kind === "integer"
        ? `${option.name} <integer>`
        : `${option.name} <value>`;
  if (option.kind === "repeatable") return option.required === true ? `${value}...` : `[${value}]...`;
  return option.required === true ? value : `[${value}]`;
}

function commandSyntax(definition: NativeControlCommandDefinition): string {
  const parts = ["/plugin", ...definition.path];
  for (const positional of definition.positionals) {
    const value = `<${positional.name}>${positional.repeatable === true ? "..." : ""}`;
    parts.push(positional.required === true ? value : `[${value}]`);
  }
  parts.push(...definition.options.map(optionSyntax));
  return parts.join(" ");
}

function markdown(value: string): string {
  return value.replaceAll("|", "\\|");
}

function registryTable(): string {
  const lines = [
    "| ID | Canonical form | Safety | Input | Summary |",
    "|---|---|---|---|---|",
  ];
  for (const [id, definition] of Object.entries(NativeControlCommandRegistry)) {
    lines.push(`| \`${id}\` | \`${markdown(commandSyntax(definition))}\` | \`${definition.safety}\` | \`${definition.input}\` | ${definition.summary.text} |`);
  }
  return lines.join("\n");
}

function aliasTable(): string {
  const lines = ["| Alias | Canonical path |", "|---|---|"];
  for (const definition of Object.values(NativeControlCommandRegistry)) {
    for (const alias of definition.aliases) {
      lines.push(`| \`/plugin ${alias.path.join(" ")}\` | \`/plugin ${definition.path.join(" ")}\` |`);
    }
  }
  return lines.join("\n");
}

describe("native control SPEC contract", () => {
  it("keeps every documented command and alias mechanically aligned with the registry", async () => {
    const spec = await readFile(specUrl, "utf8");
    expect(marked(spec, "native-control-registry")).toBe(registryTable());
    expect(marked(spec, "native-control-aliases")).toBe(aliasTable());
  });

  it("parses the documented valid examples and preserves exact invalid diagnostics", async () => {
    const spec = await readFile(specUrl, "utf8");
    const examples = marked(spec, "native-control-examples").match(/^```text\n([\s\S]*?)\n```$/u)?.[1];
    if (examples === undefined) throw new Error("native-control examples must be one text fence");
    const parser = createNativeControlParser();
    for (const line of examples.split("\n")) {
      const [expectation, invocation] = line.split(" | ", 2);
      if (expectation === undefined || invocation === undefined || !invocation.startsWith("/plugin")) {
        throw new Error(`invalid documented control example: ${line}`);
      }
      const parsed = parser.parseText(invocation.slice("/plugin".length).trimStart());
      if (expectation === "valid") expect(parsed, line).toMatchObject({ kind: "parsed" });
      else {
        const code = expectation.match(/^invalid:([A-Z][A-Z0-9_]*)$/u)?.[1];
        if (code === undefined) throw new Error(`invalid example expectation: ${expectation}`);
        expect(parsed, line).toMatchObject({ kind: "invalid", diagnostics: [{ code }] });
      }
    }
  });
});
