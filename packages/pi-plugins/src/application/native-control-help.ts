import { z } from "zod";
import { SafeDisplayFieldSchema } from "./native-inspection-contract.js";
import {
  NativeControlCommandIdSchema,
  NativeControlCommandRegistry,
  NativeControlGrammarVersionSchema,
  type NativeControlCommandId,
  type NativeControlOptionDefinition,
} from "./native-control-registry.js";

const AliasSchema = z.object({
  path: z.array(z.string()).readonly(),
  deprecatedSince: NativeControlGrammarVersionSchema.optional(),
  replacement: z.string().optional(),
  removeInMajor: z.number().int().positive().optional(),
}).strict().readonly();

const HelpOptionSchema = z.object({
  name: z.string().regex(/^--[a-z][a-z0-9-]*$/),
  kind: z.enum(["flag", "string", "integer", "enum", "repeatable"]),
  values: z.array(z.string()).readonly().optional(),
  required: z.boolean(),
  deprecatedSince: NativeControlGrammarVersionSchema.optional(),
  replacement: z.string().optional(),
  removeInMajor: z.number().int().positive().optional(),
}).strict().readonly();

export const NativeControlHelpCommandSchema = z.object({
  id: NativeControlCommandIdSchema,
  path: z.array(z.string()).readonly(),
  aliases: z.array(AliasSchema).readonly(),
  summary: SafeDisplayFieldSchema,
  safety: z.enum(["pure", "local-read", "remote-read", "mutation", "operation-control"]),
  input: z.enum(["none", "confirmation", "configuration", "decision"]),
  positionals: z.array(z.object({ name: z.string(), required: z.boolean(), repeatable: z.boolean() }).strict().readonly()).readonly(),
  options: z.array(HelpOptionSchema).readonly(),
}).strict().readonly();

export const NativeControlHelpSchema = z.object({
  grammarVersion: NativeControlGrammarVersionSchema,
  path: z.array(z.string()).readonly(),
  commands: z.array(NativeControlHelpCommandSchema).readonly(),
}).strict().readonly();
export type NativeControlHelp = z.infer<typeof NativeControlHelpSchema>;

export const NativeControlExpectationSchema = z.object({
  kind: z.enum(["command", "positional", "option", "option-value", "end"]),
  value: z.string().max(256),
}).strict().readonly();
export type NativeControlExpectation = z.infer<typeof NativeControlExpectationSchema>;

export const NativeControlCompletionRequestSchema = z.object({
  text: z.string().max(1_048_576),
  dynamic: z.array(z.object({
    category: z.enum(["plugin", "marketplace", "candidate", "notice"]),
    value: z.string().min(1).max(512),
    safe: SafeDisplayFieldSchema,
  }).strict().readonly()).max(512).readonly().default([]),
}).strict().readonly();
export type NativeControlCompletionRequest = z.infer<typeof NativeControlCompletionRequestSchema>;
export type NativeControlDynamicCandidate = NativeControlCompletionRequest["dynamic"][number];

export const NativeControlCompletionResultSchema = z.object({
  grammarVersion: NativeControlGrammarVersionSchema,
  candidates: z.array(z.object({
    value: z.string().min(1).max(512),
    kind: z.enum(["command", "option", "enum", "dynamic"]),
    canonical: z.boolean(),
    deprecatedSince: NativeControlGrammarVersionSchema.optional(),
    safe: SafeDisplayFieldSchema,
  }).strict().readonly()).max(1024).readonly(),
  incomplete: z.boolean(),
}).strict().readonly();
export type NativeControlCompletionResult = z.infer<typeof NativeControlCompletionResultSchema>;

function optionHelp(option: NativeControlOptionDefinition) {
  return {
    name: option.name,
    kind: option.kind,
    ...(option.values === undefined ? {} : { values: option.values }),
    required: option.required === true,
    ...(option.deprecatedSince === undefined ? {} : { deprecatedSince: option.deprecatedSince }),
    ...(option.replacement === undefined ? {} : { replacement: option.replacement }),
    ...(option.removeInMajor === undefined ? {} : { removeInMajor: option.removeInMajor }),
  };
}

function commandHelp(id: NativeControlCommandId) {
  const definition = NativeControlCommandRegistry[id];
  return {
    id,
    path: definition.path,
    aliases: definition.aliases,
    summary: definition.summary,
    safety: definition.safety,
    input: definition.input,
    positionals: definition.positionals.map((position) => ({ name: position.name, required: position.required === true, repeatable: position.repeatable === true })),
    options: definition.options.map(optionHelp),
  };
}

export function createNativeControlHelp(path: readonly string[] = []): NativeControlHelp {
  const matches = (Object.keys(NativeControlCommandRegistry) as NativeControlCommandId[]).filter((id) => {
    const definition = NativeControlCommandRegistry[id];
    if (path.length === 0) return id !== "presentation" && definition.visibility === "primary";
    return path.every((segment, index) => definition.path[index] === segment) ||
      definition.aliases.some((alias) => path.every((segment, index) => alias.path[index] === segment));
  });
  return NativeControlHelpSchema.parse({
    grammarVersion: "plugin-control/v1",
    path,
    commands: matches.map(commandHelp),
  });
}

export function nativeControlGrammarMetadata() {
  return Object.freeze({
    grammarVersion: "plugin-control/v1" as const,
    envelopeVersion: 1 as const,
    commands: createNativeControlHelp().commands,
  });
}
