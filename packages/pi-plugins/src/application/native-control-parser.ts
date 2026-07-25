import { z } from "zod";
import { SafeDisplayFieldSchema } from "./native-inspection-contract.js";
import {
  NativeControlCommandRegistry,
  NativeControlCommandSchema,
  NativeControlInvocationSchema,
  type NativeControlCommandId,
  type NativeControlInputChannel,
  type NativeControlInvocation,
} from "./native-control-registry.js";
import { NativeControlDiagnosticSchema, type NativeControlDiagnostic } from "./native-control-contract.js";
import {
  NativeControlCompletionRequestSchema,
  NativeControlCompletionResultSchema,
  NativeControlExpectationSchema,
  NativeControlHelpSchema,
  createNativeControlHelp,
  type NativeControlCompletionRequest,
  type NativeControlCompletionResult,
  type NativeControlHelp,
} from "./native-control-help.js";
import { NativeControlArgvSchema, lexNativeControlText } from "./native-control-lexer.js";
import { containsUnsafeNativeControlScalar } from "./native-control-scalar.js";

export const NativeControlParseResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("parsed"), command: NativeControlCommandSchema, warnings: z.array(NativeControlDiagnosticSchema).readonly() }).strict().readonly(),
  z.object({ kind: z.literal("help"), help: NativeControlHelpSchema }).strict().readonly(),
  z.object({ kind: z.literal("incomplete"), expected: z.array(NativeControlExpectationSchema).readonly(), diagnostics: z.array(NativeControlDiagnosticSchema).nonempty().readonly() }).strict().readonly(),
  z.object({ kind: z.literal("invalid"), diagnostics: z.array(NativeControlDiagnosticSchema).nonempty().readonly() }).strict().readonly(),
]);
export type NativeControlParseResult = z.infer<typeof NativeControlParseResultSchema>;

export interface NativeControlParser {
  parseArgv(argv: readonly string[]): NativeControlParseResult;
  parseText(text: string, mode?: "execute" | "complete"): NativeControlParseResult;
  help(path?: readonly string[]): NativeControlHelp;
  complete(input: NativeControlCompletionRequest): NativeControlCompletionResult;
}

type ParsedOptionValues = Record<string, string | boolean | readonly string[]>;
type PathMatch = Readonly<{ id: NativeControlCommandId; length: number; alias?: (typeof NativeControlCommandRegistry)[NativeControlCommandId]["aliases"][number] }>;

const diagnostic = (code: string, action: NativeControlDiagnostic["action"] = "reparse", severity: NativeControlDiagnostic["severity"] = "error", field?: string): NativeControlDiagnostic =>
  NativeControlDiagnosticSchema.parse({ code, severity, action, ...(field === undefined ? {} : { field }) });

function scalarIsValid(value: string): boolean {
  return value.length <= 8192 && !containsUnsafeNativeControlScalar(value);
}

function pathMatch(tokens: readonly string[]): PathMatch | undefined {
  const matches: PathMatch[] = [];
  for (const id of Object.keys(NativeControlCommandRegistry) as NativeControlCommandId[]) {
    const definition = NativeControlCommandRegistry[id];
    if (id === "presentation") continue;
    if (definition.path.length <= tokens.length && definition.path.every((part, index) => tokens[index] === part)) {
      matches.push({ id, length: definition.path.length });
    }
    for (const alias of definition.aliases) {
      if (alias.path.length <= tokens.length && alias.path.every((part, index) => tokens[index] === part)) {
        matches.push({ id, length: alias.path.length, alias });
      }
    }
  }
  return matches.sort((left, right) => right.length - left.length)[0];
}

function parseGlobal(tokens: readonly string[]): Readonly<{ invocation: NativeControlInvocation; consumed: number } | { diagnostics: readonly [NativeControlDiagnostic, ...NativeControlDiagnostic[]] }> {
  const values: Record<string, unknown> = { grammarVersion: "plugin-control/v1", output: "human", nonInteractive: false, input: { kind: "none" } };
  const seen = new Set<string>();
  let input: NativeControlInputChannel = { kind: "none" };
  let index = 0;
  const valueOptions = new Map([
    ["--grammar-version", "grammarVersion"],
    ["--output", "output"],
    ["--timeout-ms", "timeoutMs"],
    ["--input-file", "inputFile"],
    ["--input-env-prefix", "inputEnvironment"],
  ]);
  while (index < tokens.length && tokens[index]!.startsWith("--")) {
    const raw = tokens[index]!;
    const equal = raw.indexOf("=");
    const name = equal < 0 ? raw : raw.slice(0, equal);
    if (![...valueOptions.keys(), "--non-interactive", "--input-stdin"].includes(name)) break;
    if (seen.has(name)) return { diagnostics: [diagnostic("CONTROL_OPTION_DUPLICATE")] };
    seen.add(name);
    if (name === "--non-interactive") {
      if (equal >= 0) return { diagnostics: [diagnostic("CONTROL_OPTION_VALUE_UNEXPECTED")] };
      values.nonInteractive = true;
      index += 1;
      continue;
    }
    if (name === "--input-stdin") {
      if (equal >= 0) return { diagnostics: [diagnostic("CONTROL_OPTION_VALUE_UNEXPECTED")] };
      if (input.kind !== "none") return { diagnostics: [diagnostic("CONTROL_INPUT_CHANNEL_CONFLICT")] };
      input = { kind: "stdin-json" };
      index += 1;
      continue;
    }
    const inline = equal < 0 ? undefined : raw.slice(equal + 1);
    const next = inline ?? tokens[index + 1];
    if (next === undefined || (inline === undefined && next.startsWith("--"))) return { diagnostics: [diagnostic("CONTROL_OPTION_VALUE_MISSING")] };
    index += inline === undefined ? 2 : 1;
    if (name === "--input-file") {
      if (input.kind !== "none") return { diagnostics: [diagnostic("CONTROL_INPUT_CHANNEL_CONFLICT")] };
      input = { kind: "file-json", locator: next };
    } else if (name === "--input-env-prefix") {
      if (input.kind !== "none") return { diagnostics: [diagnostic("CONTROL_INPUT_CHANNEL_CONFLICT")] };
      input = { kind: "environment", prefix: next };
    } else if (name === "--timeout-ms") values.timeoutMs = Number(next);
    else values[valueOptions.get(name)!] = next;
  }
  values.input = input;
  const parsed = NativeControlInvocationSchema.safeParse(values);
  return parsed.success ? { invocation: parsed.data, consumed: index } : { diagnostics: [diagnostic("CONTROL_GLOBAL_OPTION_INVALID")] };
}

function parseLocal(id: NativeControlCommandId, tokens: readonly string[]): Readonly<{ options: ParsedOptionValues; positionals: readonly string[]; warnings: readonly NativeControlDiagnostic[] } | { diagnostics: readonly [NativeControlDiagnostic, ...NativeControlDiagnostic[]] }> {
  const definition = NativeControlCommandRegistry[id];
  const owned = new Map(definition.options.map((entry) => [entry.name, entry]));
  const values: Record<string, string | boolean | string[]> = {};
  const seen = new Set<string>();
  const positionals: string[] = [];
  const warnings: NativeControlDiagnostic[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const raw = tokens[index]!;
    if (raw === "--") return { diagnostics: [diagnostic("CONTROL_END_OPTIONS_UNSUPPORTED")] };
    if (!raw.startsWith("--")) {
      positionals.push(raw);
      continue;
    }
    const equal = raw.indexOf("=");
    const name = (equal < 0 ? raw : raw.slice(0, equal)) as `--${string}`;
    const definitionOption = owned.get(name);
    if (definitionOption === undefined) return { diagnostics: [diagnostic("CONTROL_OPTION_UNKNOWN")] };
    if (equal >= 0 && definitionOption.equals !== true) return { diagnostics: [diagnostic("CONTROL_OPTION_EQUALS_UNSUPPORTED")] };
    if (definitionOption.kind !== "repeatable" && seen.has(definitionOption.key)) return { diagnostics: [diagnostic("CONTROL_OPTION_DUPLICATE")] };
    seen.add(definitionOption.key);
    if (definitionOption.deprecatedSince !== undefined) warnings.push(diagnostic("CONTROL_SYNTAX_DEPRECATED", "reparse", "warning"));
    if (definitionOption.kind === "flag") {
      if (equal >= 0) return { diagnostics: [diagnostic("CONTROL_OPTION_VALUE_UNEXPECTED")] };
      values[definitionOption.key] = true;
      continue;
    }
    const inline = equal < 0 ? undefined : raw.slice(equal + 1);
    const next = inline ?? tokens[index + 1];
    if (next === undefined || (inline === undefined && next.startsWith("--"))) return { diagnostics: [diagnostic("CONTROL_OPTION_VALUE_MISSING")] };
    if (inline === undefined) index += 1;
    if (definitionOption.kind === "integer" && !/^(0|[1-9][0-9]*)$/.test(next)) return { diagnostics: [diagnostic("CONTROL_OPTION_INTEGER_INVALID")] };
    if (definitionOption.values !== undefined && !definitionOption.values.includes(next)) return { diagnostics: [diagnostic("CONTROL_OPTION_ENUM_INVALID")] };
    if (definitionOption.kind === "repeatable") {
      const current = values[definitionOption.key];
      values[definitionOption.key] = [...(Array.isArray(current) ? current : []), next];
    } else values[definitionOption.key] = definitionOption.kind === "integer" ? String(Number(next)) : next;
  }

  for (const required of definition.options.filter((entry) => entry.required === true)) {
    if (!seen.has(required.key)) return { diagnostics: [diagnostic("CONTROL_OPTION_REQUIRED")] };
  }
  for (const entry of definition.options) {
    if (!seen.has(entry.key)) continue;
    for (const conflict of entry.conflicts ?? []) if (seen.has(conflict)) return { diagnostics: [diagnostic("CONTROL_OPTION_CONFLICT")] };
  }
  if (id === "lifecycle.uninstall" && !seen.has("keepData") && !seen.has("deleteData")) {
    return { diagnostics: [diagnostic("CONTROL_RETENTION_REQUIRED", "confirm-exact")] };
  }
  const repeated = definition.positionals.find((entry) => entry.repeatable === true);
  const requiredCount = definition.positionals.filter((entry) => entry.required === true && entry.repeatable !== true).length + (repeated?.required === true ? 1 : 0);
  const maximum = repeated === undefined ? definition.positionals.length : Number.POSITIVE_INFINITY;
  if (positionals.length < requiredCount) return { diagnostics: [diagnostic("CONTROL_POSITIONAL_MISSING")] };
  if (positionals.length > maximum) return { diagnostics: [diagnostic("CONTROL_POSITIONAL_EXTRA")] };
  return { options: values, positionals: Object.freeze(positionals), warnings: Object.freeze(warnings) };
}

const stringValue = (options: ParsedOptionValues, key: string): string | undefined => typeof options[key] === "string" ? options[key] : undefined;
const boolValue = (options: ParsedOptionValues, key: string): boolean => options[key] === true;
const stringsValue = (options: ParsedOptionValues, key: string): readonly string[] | undefined => Array.isArray(options[key]) ? options[key] as readonly string[] : undefined;
const numberValue = (options: ParsedOptionValues, key: string): number | undefined => stringValue(options, key) === undefined ? undefined : Number(stringValue(options, key));

function targetRequest(options: ParsedOptionValues, positionals: readonly string[]) {
  return {
    plugin: positionals[0], scope: stringValue(options, "scope"),
    ...(stringValue(options, "snapshotId") === undefined ? {} : { snapshotId: stringValue(options, "snapshotId") }),
    ...(stringValue(options, "detailId") === undefined ? {} : { detailId: stringValue(options, "detailId") }),
  };
}

function policyChange(options: ParsedOptionValues): unknown {
  const kind = stringValue(options, "policyKind");
  const targetKind = stringValue(options, "policyTarget");
  const scope = stringValue(options, "scope");
  const target = targetKind === "global" ? { kind: "global" }
    : targetKind === "scope" && (scope === "user" || scope === "project") ? { kind: "scope", scope }
    : targetKind === "marketplace" && (scope === "user" || scope === "project") ? { kind: "marketplace", scope, registrationId: stringValue(options, "marketplaceId") }
    : targetKind === "plugin" && (scope === "user" || scope === "project") ? { kind: "plugin", scope, plugin: stringValue(options, "plugin") }
    : { kind: targetKind };
  if (kind === "cadence") return { kind, target, cadence: stringValue(options, "cadence") };
  return { kind, target, mode: stringValue(options, "policyMode") };
}

function normalizeRequest(id: NativeControlCommandId, options: ParsedOptionValues, positionals: readonly string[]): unknown {
  switch (id) {
    case "presentation": return {};
    case "help": return { path: positionals };
    case "grammar": return { ...(stringValue(options, "version") === undefined ? {} : { version: stringValue(options, "version") }) };
    case "marketplace.add": {
      // GitHub shorthand is the common marketplace source. Explicit kinds stay
      // available for URLs and local checkouts without burdening the default.
      const sourceKind = stringValue(options, "sourceKind") ?? "github";
      const source = sourceKind === "github" ? { kind: "github", repository: positionals[0], ...(stringValue(options, "ref") === undefined ? {} : { ref: stringValue(options, "ref") }) }
        : sourceKind === "git" ? { kind: "git", url: positionals[0], ...(stringValue(options, "ref") === undefined ? {} : { ref: stringValue(options, "ref") }) }
        : { kind: "local-git", path: positionals[0], ...(stringValue(options, "ref") === undefined ? {} : { ref: stringValue(options, "ref") }) };
      return { source };
    }
    case "marketplace.remove": return { registrationId: positionals[0], confirmed: boolValue(options, "confirmed") };
    case "marketplace.list": return { limit: numberValue(options, "limit") ?? 50 };
    case "marketplace.refresh": return { ...(positionals.length === 0 ? {} : { registrationIds: positionals }) };
    case "marketplace.adopt.preview": return {};
    case "marketplace.adopt.import": return { candidateIds: positionals, confirmed: boolValue(options, "confirmed") };
    case "browse": return { query: positionals[0] ?? "", scope: stringValue(options, "scope") ?? "all-current", ...(stringsValue(options, "marketplaceIds") === undefined ? {} : { marketplaceIds: stringsValue(options, "marketplaceIds") }), ...(stringsValue(options, "availability") === undefined ? {} : { availability: stringsValue(options, "availability") }), ...(stringValue(options, "cursor") === undefined ? {} : { cursor: stringValue(options, "cursor") }), limit: numberValue(options, "limit") ?? 50 };
    case "inspection.list": return { scope: stringValue(options, "scope") ?? "all-current", query: stringValue(options, "query") ?? "", ...(stringsValue(options, "conditions") === undefined ? {} : { conditions: stringsValue(options, "conditions") }), ...(stringValue(options, "cursor") === undefined ? {} : { cursor: stringValue(options, "cursor") }), limit: numberValue(options, "limit") ?? 50 };
    case "inspection.show":
    case "install.open":
    case "install.run": return targetRequest(options, positionals);
    case "inspection.diagnose": return { ...(positionals[0] === undefined ? {} : { plugin: positionals[0], scope: stringValue(options, "scope") }), includeAdoption: boolValue(options, "includeAdoption"), ...(stringValue(options, "snapshotId") === undefined ? {} : { snapshotId: stringValue(options, "snapshotId") }), ...(stringValue(options, "detailId") === undefined ? {} : { detailId: stringValue(options, "detailId") }) };
    case "install.apply":
    case "install.recover": return { token: positionals[0] };
    case "lifecycle.enable":
    case "lifecycle.disable": return { ...targetRequest(options, positionals), previewOnly: boolValue(options, "previewOnly"), confirmed: boolValue(options, "confirmed") };
    case "lifecycle.update": return { ...targetRequest(options, positionals), previewOnly: boolValue(options, "previewOnly"), confirmed: boolValue(options, "confirmed"), ...(stringValue(options, "candidateSnapshotId") === undefined ? {} : { candidateSnapshotId: stringValue(options, "candidateSnapshotId") }), ...(stringValue(options, "candidateDetailId") === undefined ? {} : { candidateDetailId: stringValue(options, "candidateDetailId") }) };
    case "lifecycle.uninstall": return { ...targetRequest(options, positionals), previewOnly: boolValue(options, "previewOnly"), confirmed: boolValue(options, "confirmed"), persistentData: boolValue(options, "deleteData") ? "delete-confirmed" : "keep" };
    case "project.sync": return { mode: stringValue(options, "mode"), previewOnly: boolValue(options, "previewOnly"), confirmed: boolValue(options, "confirmed") };
    case "updates.status": return { scope: stringValue(options, "scope") ?? "all-current", ...(stringValue(options, "plugin") === undefined ? {} : { plugin: stringValue(options, "plugin") }) };
    case "updates.policy.preview": return { change: policyChange(options) };
    case "updates.policy.apply": return { change: policyChange(options), previewId: stringValue(options, "previewId"), ...(stringValue(options, "consentId") === undefined ? {} : { consentId: stringValue(options, "consentId") }) };
    case "updates.policy.set": return { change: policyChange(options), ...(stringValue(options, "previewId") === undefined ? {} : { previewId: stringValue(options, "previewId") }), ...(stringValue(options, "consentId") === undefined ? {} : { consentId: stringValue(options, "consentId") }) };
    case "updates.notices.list": return { scope: stringValue(options, "scope") ?? "all-current", ...(stringValue(options, "plugin") === undefined ? {} : { plugin: stringValue(options, "plugin") }), ...(stringValue(options, "after") === undefined ? {} : { after: stringValue(options, "after") }), limit: numberValue(options, "limit") ?? 50 };
    case "updates.notices.acknowledge": return { ids: positionals };
    case "updates.automatic.run": return { ...(stringsValue(options, "noticeIds") === undefined ? {} : { noticeIds: stringsValue(options, "noticeIds") }), limit: numberValue(options, "limit") ?? 20 };
    case "config.host-precedence": return { order: positionals[0] };
    case "status": return {};
    case "operation.status":
    case "operation.cancel": return { token: positionals[0] };
  }
}

function parseArgv(argvInput: readonly string[]): NativeControlParseResult {
  const argv = NativeControlArgvSchema.safeParse(argvInput);
  if (!argv.success) return { kind: "invalid", diagnostics: [diagnostic("CONTROL_ARGV_INVALID")] };
  if (argv.data.some((value) => !scalarIsValid(value))) return { kind: "invalid", diagnostics: [diagnostic("CONTROL_ARGV_UNSAFE")] };
  const global = parseGlobal(argv.data);
  if ("diagnostics" in global) return { kind: "invalid", diagnostics: global.diagnostics };
  const remaining = argv.data.slice(global.consumed);
  if (remaining.length === 0) {
    return { kind: "parsed", command: NativeControlCommandSchema.parse({ command: "presentation", request: {}, invocation: global.invocation }), warnings: [] };
  }
  const match = pathMatch(remaining);
  if (match === undefined) return { kind: "invalid", diagnostics: [diagnostic("CONTROL_COMMAND_UNKNOWN")] };
  const local = parseLocal(match.id, remaining.slice(match.length));
  if ("diagnostics" in local) return { kind: "invalid", diagnostics: local.diagnostics };
  const request = normalizeRequest(match.id, local.options, local.positionals);
  const parsed = NativeControlCommandSchema.safeParse({ command: match.id, request, invocation: global.invocation });
  if (!parsed.success) return { kind: "invalid", diagnostics: [diagnostic("CONTROL_REQUEST_INVALID")] };
  const warnings = [...local.warnings];
  if (match.alias?.deprecatedSince !== undefined) warnings.push(diagnostic("CONTROL_SYNTAX_DEPRECATED", "reparse", "warning"));
  if (match.id === "help") {
    const help = createNativeControlHelp((parsed.data.request as { path: readonly string[] }).path);
    return help.commands.length === 0
      ? { kind: "invalid", diagnostics: [diagnostic("CONTROL_HELP_PATH_UNKNOWN")] }
      : { kind: "help", help };
  }
  return { kind: "parsed", command: parsed.data, warnings: Object.freeze(warnings) };
}

function completion(inputValue: NativeControlCompletionRequest): NativeControlCompletionResult {
  const input = NativeControlCompletionRequestSchema.parse(inputValue);
  const lexed = lexNativeControlText(input.text, "complete");
  if (lexed.kind === "invalid") return { grammarVersion: "plugin-control/v1", candidates: [], incomplete: true };
  const tokens = lexed.tokens.map((token) => token.value);
  const trailingSeparator = /[ \t]$/.test(input.text);
  const prefix = trailingSeparator ? "" : tokens.at(-1) ?? "";
  const completed = trailingSeparator ? tokens : tokens.slice(0, -1);
  const candidates: Array<z.infer<typeof NativeControlCompletionResultSchema>["candidates"][number]> = [];
  const safe = (text: string) => SafeDisplayFieldSchema.parse({ text, escaped: false, truncated: false });
  const add = (value: string, kind: "command" | "option" | "enum" | "dynamic", canonical = true, deprecatedSince?: "plugin-control/v1") => {
    if (!value.startsWith(prefix)) return;
    candidates.push({ value, kind, canonical, ...(deprecatedSince === undefined ? {} : { deprecatedSince }), safe: safe(value) });
  };

  const matched = pathMatch(completed);
  if (matched === undefined && completed.length === 0) {
    for (const definition of Object.values(NativeControlCommandRegistry)) {
      if (definition.visibility !== "primary") continue;
      if (definition.path.length > 0) add(definition.path.join(" "), "command");
      // Compatibility aliases remain parseable but do not crowd the normal
      // command picker with protocol-shaped or superseded vocabulary.
    }
  } else if (matched !== undefined) {
    const definition = NativeControlCommandRegistry[matched.id];
    const prior = completed.at(-1);
    const optionDefinition = definition.options.find((entry) => entry.name === prior);
    if (optionDefinition?.values !== undefined) for (const value of optionDefinition.values) add(value, "enum");
    else if (prefix.startsWith("--") || prefix === "") for (const owned of definition.options) add(owned.name, "option", true, owned.deprecatedSince);
    const positionalIndex = completed.slice(matched.length).filter((value) => !value.startsWith("--")).length;
    const positional = definition.positionals[Math.min(positionalIndex, Math.max(0, definition.positionals.length - 1))];
    const category = positional?.name.includes("plugin") ? "plugin" : positional?.name.includes("candidate") ? "candidate" : positional?.name.includes("notice") ? "notice" : positional?.name.includes("marketplace") ? "marketplace" : undefined;
    if (category !== undefined) for (const dynamic of input.dynamic) if (dynamic.category === category) add(dynamic.value, "dynamic");
  }
  return NativeControlCompletionResultSchema.parse({ grammarVersion: "plugin-control/v1", candidates, incomplete: lexed.tokens.some((token) => !token.complete) });
}

export function createNativeControlParser(): NativeControlParser {
  return Object.freeze({
    parseArgv,
    parseText(text: string, mode: "execute" | "complete" = "execute") {
      const lexed = lexNativeControlText(text, mode);
      if (lexed.kind === "invalid") return mode === "complete"
        ? { kind: "incomplete" as const, expected: [{ kind: "end" as const, value: "complete token" }], diagnostics: [diagnostic(lexed.code)] }
        : { kind: "invalid" as const, diagnostics: [diagnostic(lexed.code)] };
      if (mode === "complete" && lexed.tokens.some((token) => !token.complete)) {
        return { kind: "incomplete" as const, expected: [{ kind: "end" as const, value: "complete token" }], diagnostics: [diagnostic("CONTROL_PARTIAL_INPUT")] };
      }
      return parseArgv(lexed.tokens.map((token) => token.value));
    },
    help: createNativeControlHelp,
    complete: completion,
  });
}
