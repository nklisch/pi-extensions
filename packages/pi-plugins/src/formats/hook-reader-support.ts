import { z } from "zod";
import {
  HookComponentSchema,
  HookShellSchema,
  RetainedMetadataSchema,
  type HookComponent,
  type HookHandler,
  type HookShell,
  type RetainedMetadata,
  ForeignComponentSchema,
  type ForeignComponent,
} from "../domain/components.js";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  type Diagnostic,
  type ReadResult,
} from "../domain/errors.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import {
  claim,
  ProvenanceSchema,
  type Claimed,
  type NativeHost,
  type Provenance,
} from "../domain/provenance.js";
import { JsonValueSchema, type JsonValue } from "../domain/schema.js";
import { HOOK_MAX_TIMEOUT_MS } from "../domain/hook-runtime-limits.js";
import { stableComponentId, stableJson } from "./stable-component-id.js";
import { createForeignComponentDeclaration } from "./foreign-declaration.js";

export type HookDocumentReaderContext = Readonly<{
  plugin: PluginKey;
  nativeHost: NativeHost;
  provenance: Provenance;
}>;

export type HookDocumentReader = (
  input: unknown,
  context: HookDocumentReaderContext,
) => ReadResult<readonly (HookComponent | ForeignComponent)[]>;

export class HookReaderFailure extends Error {
  readonly pointer: string;
  readonly details: JsonValue | undefined;

  constructor(pointer: string, message: string, details?: JsonValue) {
    super(message);
    this.name = "HookReaderFailure";
    this.pointer = pointer;
    this.details = details;
  }
}

export function failHook(
  pointer: string,
  message: string,
  details?: JsonValue,
): never {
  throw new HookReaderFailure(pointer, message, details);
}

export function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function has(value: { readonly [key: string]: JsonValue }, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function pointerSegment(key: string | number): string {
  return String(key).replaceAll("~", "~0").replaceAll("/", "~1");
}

export function childPointer(base: string | undefined, key: string | number): string {
  return `${base ?? ""}/${pointerSegment(key)}`;
}

export function sourceAt(
  context: HookDocumentReaderContext,
  pointer: string,
  declaration?: JsonValue,
): Provenance {
  const location = {
    ...context.provenance.location,
    pointer,
  };
  return ProvenanceSchema.parse({
    location,
    ...(declaration === undefined ? {} : { declaration }),
  });
}

export function claimedAt<T>(
  value: T,
  context: HookDocumentReaderContext,
  pointer: string,
  declaration?: JsonValue,
): Claimed<T> {
  return claim(value, sourceAt(context, pointer, declaration));
}

export function metadataAt(
  context: HookDocumentReaderContext,
  key: string,
  value: JsonValue,
  pointer: string,
  declaration?: JsonValue,
): RetainedMetadata {
  return RetainedMetadataSchema.parse({
    key: `${context.nativeHost}.hook.${key}`,
    claimed: claim(value, sourceAt(context, pointer, declaration)),
  });
}

function provenanceKey(provenance: Provenance): string {
  const location = provenance.location;
  return stableJson([
    location.host,
    location.documentKind,
    location.path,
    location.pointer ?? "",
    location.line ?? 0,
    location.column ?? 0,
  ]);
}

export function mergeProvenance(
  left: readonly Provenance[],
  right: readonly Provenance[],
): readonly [Provenance, ...Provenance[]] {
  const all = [...left, ...right].sort((a, b) => {
    const leftKey = provenanceKey(a);
    const rightKey = provenanceKey(b);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const result: Provenance[] = [];
  for (const candidate of all) {
    if (!result.some((existing) => provenanceKey(existing) === provenanceKey(candidate))) {
      result.push(candidate);
    }
  }
  if (result.length === 0) throw new Error("merged provenance cannot be empty");
  return result as [Provenance, ...Provenance[]];
}

export function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

export function invalidHookResult<T>(
  operation: string,
  context: HookDocumentReaderContext,
  error: unknown,
): ReadResult<T> {
  let pointer = context.provenance.location.pointer ?? "";
  let message = `${operation} input is invalid`;
  let details: JsonValue | undefined;

  if (error instanceof HookReaderFailure) {
    pointer = error.pointer;
    message = error.message;
    details = error.details;
  } else if (error instanceof z.ZodError) {
    const first = error.issues[0];
    pointer = childPointer(pointer, first?.path.join("/") ?? "");
    message = first?.message ?? message;
    details = {
      issues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map(String),
        message: issue.message,
      })),
    };
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }

  const diagnostic: Diagnostic = DiagnosticSchema.parse({
    code: ErrorCodeRegistry.schemaInvalid,
    severity: "error",
    operation,
    message,
    location: {
      ...context.provenance.location,
      pointer,
    },
    plugin: PluginKeySchema.parse(context.plugin),
    ...(details === undefined ? {} : { details }),
  });
  return { ok: false, diagnostics: [diagnostic] };
}

export function readHookDocument<T>(
  operation: string,
  input: unknown,
  context: HookDocumentReaderContext,
  read: (value: JsonValue) => readonly (HookComponent | ForeignComponent)[],
): ReadResult<readonly (HookComponent | ForeignComponent)[]> {
  try {
    const validContext = {
      ...context,
      plugin: PluginKeySchema.parse(context.plugin),
    };
    const value = JsonValueSchema.parse(input);
    const result = read(value);
    const validated = result.map((component) =>
      component.kind === "hook"
        ? HookComponentSchema.parse(component)
        : ForeignComponentSchema.parse(component),
    );
    return { ok: true, value: validated, diagnostics: [] };
  } catch (error) {
    return invalidHookResult(operation, context, error);
  }
}

export function foreignFromHook(
  context: HookDocumentReaderContext,
  nativeKind: string,
  declarationSubkey: string,
  declaration: JsonValue,
  pointer: string,
): ForeignComponent {
  const provenance = sourceAt(context, pointer, declaration);
  const result = createForeignComponentDeclaration({
    nativeHost: context.nativeHost,
    nativeKind,
    declarationSubkey,
    declaration,
    provenance,
  });
  if (!result.ok) {
    const diagnostic = result.diagnostics[0];
    throw new HookReaderFailure(
      pointer,
      diagnostic?.message ?? "invalid foreign hook declaration",
      diagnostic?.details,
    );
  }
  const identity = {
    kind: "foreign" as const,
    nativeHost: context.nativeHost,
    nativeKind,
    declarationSubkey,
  };
  return ForeignComponentSchema.parse({
    kind: "foreign",
    id: stableComponentId(context.plugin, identity),
    nativeHost: context.nativeHost,
    nativeKind: claim(nativeKind, provenance),
    declarationSubkey,
    declaration: claim(declaration, provenance),
  });
}

export function mergeHookComponents(
  left: HookComponent,
  right: HookComponent,
): HookComponent {
  if (
    left.event.value !== right.event.value ||
    !sameJson(left.matcher?.value, right.matcher?.value) ||
    !sameJson(left.handler.value, right.handler.value)
  ) {
    throw new HookReaderFailure(
      right.handler.provenance[0]?.location.pointer ?? "",
      "equivalent hook identity carries contradictory claims",
      {
        left: left as unknown as JsonValue,
        right: right as unknown as JsonValue,
      },
    );
  }

  const metadata = [...left.metadata];
  for (const candidate of right.metadata) {
    const existing = metadata.find((entry) => entry.key === candidate.key);
    if (existing === undefined) {
      metadata.push(candidate);
      continue;
    }
    if (!sameJson(existing.claimed.value, candidate.claimed.value)) {
      throw new HookReaderFailure(
        candidate.claimed.provenance[0]?.location.pointer ?? "",
        `conflicting hook metadata claim for ${candidate.key}`,
        {
          left: existing.claimed.value,
          right: candidate.claimed.value,
        },
      );
    }
    metadata[metadata.indexOf(existing)] = {
      key: existing.key,
      claimed: {
        value: existing.claimed.value,
        provenance: mergeProvenance(existing.claimed.provenance, candidate.claimed.provenance),
      },
    };
  }
  return HookComponentSchema.parse({
    ...left,
    event: {
      value: left.event.value,
      provenance: mergeProvenance(left.event.provenance, right.event.provenance),
    },
    ...(left.matcher === undefined
      ? {}
      : {
          matcher: {
            value: left.matcher.value,
            provenance: mergeProvenance(left.matcher.provenance, right.matcher?.provenance ?? []),
          },
        }),
    handler: {
      value: left.handler.value,
      provenance: mergeProvenance(left.handler.provenance, right.handler.provenance),
    },
    metadata,
  });
}

export function mergeForeignComponents(
  left: ForeignComponent,
  right: ForeignComponent,
): ForeignComponent {
  if (
    left.nativeHost !== right.nativeHost ||
    left.nativeKind.value !== right.nativeKind.value ||
    left.declarationSubkey !== right.declarationSubkey ||
    !sameJson(left.declaration.value, right.declaration.value)
  ) {
    throw new HookReaderFailure(
      right.declaration.provenance[0]?.location.pointer ?? "",
      "equivalent foreign identity carries contradictory claims",
      {
        left: {
          value: left.declaration.value,
          provenance: left.declaration.provenance as unknown as JsonValue,
        },
        right: {
          value: right.declaration.value,
          provenance: right.declaration.provenance as unknown as JsonValue,
        },
      },
    );
  }
  return ForeignComponentSchema.parse({
    ...left,
    nativeKind: {
      value: left.nativeKind.value,
      provenance: mergeProvenance(left.nativeKind.provenance, right.nativeKind.provenance),
    },
    declaration: {
      value: left.declaration.value,
      provenance: mergeProvenance(left.declaration.provenance, right.declaration.provenance),
    },
  });
}

export function deduplicateHookResults(
  components: readonly (HookComponent | ForeignComponent)[],
): readonly (HookComponent | ForeignComponent)[] {
  const byId = new Map<string, HookComponent | ForeignComponent>();
  for (const component of components) {
    const existing = byId.get(component.id);
    if (existing === undefined) {
      byId.set(component.id, component);
      continue;
    }
    byId.set(
      component.id,
      component.kind === "hook" && existing.kind === "hook"
        ? mergeHookComponents(existing, component)
        : component.kind === "foreign" && existing.kind === "foreign"
          ? mergeForeignComponents(existing, component)
          : (() => {
              throw new HookReaderFailure(
                component.kind === "hook"
                  ? component.handler.provenance[0]?.location.pointer ?? ""
                  : component.declaration.provenance[0]?.location.pointer ?? "",
                "different component kinds share one stable id",
              );
            })(),
    );
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function handlerIdentity(
  event: string,
  matcher: string | undefined,
  handler: HookHandler,
): { kind: "hook"; event: string; matcher?: string; handler: HookHandler } {
  return matcher === undefined
    ? { kind: "hook", event, handler }
    : { kind: "hook", event, matcher, handler };
}

function requireRecord(value: JsonValue, pointer: string, label: string): { readonly [key: string]: JsonValue } {
  if (!isRecord(value)) failHook(pointer, `${label} must be an object`);
  return value;
}

function requireStringValue(value: JsonValue | undefined, pointer: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    failHook(pointer, `${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: JsonValue, pointer: string, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    failHook(pointer, `${label} must be an array of strings`);
  }
  return value as readonly string[];
}

function hookForeignSubkey(event: string, matcher: string | undefined, handlerIndex: number): string {
  return `event:${stableJson(event)}\u0000matcher:${matcher === undefined ? "absent" : stableJson(matcher)}\u0000handler:${handlerIndex}`;
}

function normalizedTimeout(
  record: { readonly [key: string]: JsonValue },
  pointer: string,
): number | undefined {
  const seconds = has(record, "timeout") ? record.timeout : undefined;
  const milliseconds = has(record, "timeoutMs") ? record.timeoutMs : undefined;
  const underscoredMilliseconds = has(record, "timeout_ms") ? record.timeout_ms : undefined;
  const supplied = [
    ...(seconds === undefined ? [] : [{ value: seconds, unit: "seconds" as const, field: "timeout" }]),
    ...(milliseconds === undefined ? [] : [{ value: milliseconds, unit: "milliseconds" as const, field: "timeoutMs" }]),
    ...(underscoredMilliseconds === undefined ? [] : [{ value: underscoredMilliseconds, unit: "milliseconds" as const, field: "timeout_ms" }]),
  ];
  if (supplied.length > 1) {
    failHook(pointer, "a hook handler may declare only one timeout field");
  }
  const candidate = supplied[0];
  if (candidate === undefined) return undefined;
  if (typeof candidate.value !== "number" || !Number.isFinite(candidate.value) || candidate.value <= 0) {
    failHook(childPointer(pointer, candidate.field), "timeout must be a finite positive number");
  }
  const multiplier = candidate.unit === "seconds" ? 1000 : 1;
  const normalized = Math.round(candidate.value * multiplier);
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > HOOK_MAX_TIMEOUT_MS) {
    failHook(childPointer(pointer, candidate.field), "normalized timeout is outside the supported range");
  }
  return normalized;
}

const structuralHandlerFields = new Set([
  "type", "command", "args", "timeout", "timeoutMs", "timeout_ms", "shell",
]);
const retainedHandlerFields = new Set([
  "statusMessage", "status_message", "statusText", "async", "conditions",
]);

function handlerMetadata(
  context: HookDocumentReaderContext,
  record: { readonly [key: string]: JsonValue },
  pointer: string,
  declaration: JsonValue,
): readonly RetainedMetadata[] {
  const metadata: RetainedMetadata[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (structuralHandlerFields.has(key)) continue;
    if (retainedHandlerFields.has(key)) {
      if (key === "statusMessage" || key === "status_message" || key === "statusText") {
        requireStringValue(value, childPointer(pointer, key), key);
      }
      if (key === "async" && typeof value !== "boolean") {
        failHook(childPointer(pointer, key), "async must be a boolean");
      }
      metadata.push(metadataAt(context, `handler.${key}`, value, childPointer(pointer, key), declaration));
    }
  }
  return metadata;
}

function parseCommandHandler(
  value: JsonValue,
  context: HookDocumentReaderContext,
  pointer: string,
  foreignSubkey: string,
): Readonly<{ handler?: HookHandler; metadata: readonly RetainedMetadata[]; foreign: readonly ForeignComponent[] }> {
  const record = requireRecord(value, pointer, "hook handler");
  const type = requireStringValue(record.type, childPointer(pointer, "type"), "handler type");
  const declaration = value;
  if (type !== "command" && type !== "shell" && type !== "exec") {
    return {
      metadata: [],
      foreign: [foreignFromHook(context, "hook-handler", `${foreignSubkey}/handler-type`, declaration, pointer)],
    };
  }

  const command = requireStringValue(record.command, childPointer(pointer, "command"), "command");
  const timeoutMs = normalizedTimeout(record, pointer);
  const argsValue = has(record, "args") ? record.args : undefined;
  const args = argsValue === undefined
    ? undefined
    : requireStringArray(argsValue, childPointer(pointer, "args"), "args");
  const shellValue = has(record, "shell")
    ? HookShellSchema.parse(requireStringValue(record.shell, childPointer(pointer, "shell"), "shell"))
    : undefined;
  const isExec = type === "exec" || args !== undefined;
  if (isExec && shellValue !== undefined) {
    failHook(childPointer(pointer, "shell"), "exec handlers cannot declare a shell");
  }
  if (type === "shell" && args !== undefined) {
    failHook(childPointer(pointer, "args"), "shell handlers cannot declare args");
  }
  const handler: HookHandler = isExec
    ? {
        kind: "exec",
        command,
        args: args ?? [],
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }
    : {
        kind: "shell",
        command,
        ...(shellValue === undefined || shellValue === "bash" ? {} : { shell: shellValue as HookShell }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
  const metadata = handlerMetadata(context, record, pointer, declaration);
  const foreign: ForeignComponent[] = [];
  for (const key of Object.keys(record)) {
    if (structuralHandlerFields.has(key) || retainedHandlerFields.has(key)) continue;
    // Retain unknown runtime-bearing keys as inventory instead of silently
    // treating them as part of the supported command contract.
    const declarationPointer = childPointer(pointer, key);
    foreign.push(foreignFromHook(context, "hook-handler", `${foreignSubkey}/field:${key}`, declaration, declarationPointer));
  }
  return { handler, metadata, foreign };
}

/** Parse the shared hooks.json event/group/handler vocabulary. */
export function parseHookDocument(
  value: JsonValue,
  context: HookDocumentReaderContext,
): readonly (HookComponent | ForeignComponent)[] {
  const root = requireRecord(value, context.provenance.location.pointer ?? "", "hook document");
  const rootPointer = context.provenance.location.pointer ?? "";
  const hooksValue = root.hooks;
  if (hooksValue === undefined) failHook(childPointer(rootPointer, "hooks"), "hooks must be present");
  const hooks = requireRecord(hooksValue, childPointer(rootPointer, "hooks"), "hooks");
  const components: (HookComponent | ForeignComponent)[] = [];
  for (const [event, groupsValue] of Object.entries(hooks)) {
    const eventPointer = childPointer(childPointer(rootPointer, "hooks"), event);
    if (event.length === 0) failHook(eventPointer, "hook event names cannot be empty");
    if (!Array.isArray(groupsValue)) failHook(eventPointer, "event handlers must be an array");
    for (const [groupIndex, groupValue] of groupsValue.entries()) {
      const groupPointer = childPointer(eventPointer, groupIndex);
      const group = requireRecord(groupValue, groupPointer, "hook group");
      const isGroup = has(group, "hooks");
      const matcherValue = has(group, "matcher") ? group.matcher : undefined;
      if (matcherValue !== undefined && typeof matcherValue !== "string") {
        failHook(childPointer(groupPointer, "matcher"), "matcher must be a string");
      }
      const matcher = matcherValue as string | undefined;
      const handlersValue = isGroup ? group.hooks : groupValue;
      if (isGroup && !Array.isArray(handlersValue)) {
        failHook(childPointer(groupPointer, "hooks"), "group hooks must be an array");
      }
      const handlers = isGroup ? handlersValue as readonly JsonValue[] : [handlersValue];
      const groupMetadata = isGroup
        ? Object.entries(group)
            .filter(([key]) => key !== "hooks" && key !== "matcher")
            .map(([key, declaration]) => metadataAt(context, `group.${key}`, declaration, childPointer(groupPointer, key), groupValue))
        : [];
      for (const [handlerIndex, handlerValue] of handlers.entries()) {
        const handlerPointer = isGroup
          ? childPointer(childPointer(groupPointer, "hooks"), handlerIndex)
          : groupPointer;
        const parsed = parseCommandHandler(
          handlerValue,
          context,
          handlerPointer,
          hookForeignSubkey(event, matcher, handlerIndex),
        );
        components.push(...parsed.foreign);
        if (parsed.handler === undefined) continue;
        const component = makeHookComponent(
          context,
          event,
          matcher,
          parsed.handler,
          eventPointer,
          childPointer(groupPointer, "matcher"),
          handlerPointer,
          handlerValue,
          [...groupMetadata, ...parsed.metadata],
        );
        components.push(component);
      }
    }
  }
  return deduplicateHookResults(components);
}

export function makeHookComponent(
  context: HookDocumentReaderContext,
  event: string,
  matcher: string | undefined,
  handler: HookHandler,
  eventPointer: string,
  matcherPointer: string,
  handlerPointer: string,
  declaration: JsonValue,
  metadata: readonly RetainedMetadata[],
): HookComponent {
  const eventProvenance = sourceAt(context, eventPointer, event);
  const handlerProvenance = sourceAt(context, handlerPointer, declaration);
  return HookComponentSchema.parse({
    kind: "hook",
    id: stableComponentId(context.plugin, handlerIdentity(event, matcher, handler)),
    event: claim(event, eventProvenance),
    ...(matcher === undefined
      ? {}
      : { matcher: claim(matcher, sourceAt(context, matcherPointer, matcher)) }),
    handler: claim(handler, handlerProvenance),
    metadata,
  });
}
