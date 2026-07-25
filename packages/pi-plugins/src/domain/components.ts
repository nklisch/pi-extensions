import { z } from "zod";
import { JsonValueSchema, schemaValues } from "./schema.js";
import { ClaimedSchema, NativeHostSchema } from "./provenance.js";
import { HOOK_MAX_TIMEOUT_MS } from "./hook-runtime-limits.js";

/** The public component vocabulary has one authoritative registry. */
export const ComponentKindRegistry = {
  skill: { tag: "skill", label: "Skill" },
  hook: { tag: "hook", label: "Hook" },
  mcpServer: { tag: "mcp-server", label: "MCP server" },
  foreign: { tag: "foreign", label: "Foreign component" },
} as const;

/**
 * Component ids are versioned because they are part of persisted trust and
 * installation state. The kind alternatives are derived from the component
 * registry rather than accepting arbitrary caller-defined namespaces.
 */
const componentIdKinds = Object.values(ComponentKindRegistry).map((entry) => entry.tag);
const componentIdKindPattern = componentIdKinds.join("|");

export const ComponentIdSchema = z
  .string()
  .regex(new RegExp(`^component-v1:(?:${componentIdKindPattern}):[0-9a-f]{64}$`))
  .brand<"ComponentId">();
export type ComponentId = z.infer<typeof ComponentIdSchema>;

export const RetainedMetadataSchema = z
  .object({
    key: z.string().min(1),
    claimed: ClaimedSchema(JsonValueSchema),
  })
  .strict()
  .readonly();
export type RetainedMetadata = z.infer<typeof RetainedMetadataSchema>;

export const HookShellSchema = z.enum(["bash", "powershell"]);
export type HookShell = z.infer<typeof HookShellSchema>;

const HookHandlerSchemaRegistry = {
  shell: z
    .object({
      kind: z.literal("shell"),
      command: z.string().min(1),
      shell: HookShellSchema.optional(),
      timeoutMs: z.number().int().positive().max(HOOK_MAX_TIMEOUT_MS).optional(),
    })
    .strict()
    .transform((value) => value.shell === "bash" ? {
      kind: value.kind,
      command: value.command,
      ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    } : value),
  exec: z
    .object({
      kind: z.literal("exec"),
      command: z.string().min(1),
      args: z.array(z.string()).readonly(),
      timeoutMs: z.number().int().positive().max(HOOK_MAX_TIMEOUT_MS).optional(),
    })
    .strict(),
} as const;

export const HookHandlerVariantRegistry = {
  shell: { tag: "shell", schema: HookHandlerSchemaRegistry.shell },
  exec: { tag: "exec", schema: HookHandlerSchemaRegistry.exec },
} as const;

type SchemaRegistry = Record<
  string,
  { readonly tag: string; readonly schema: z.ZodTypeAny }
>;

function schemasFor<T extends SchemaRegistry>(
  registry: T,
): [T[keyof T]["schema"], ...T[keyof T]["schema"][]] {
  const schemas = Object.fromEntries(
    Object.entries(registry).map(([key, entry]) => [key, entry.schema]),
  ) as { [K in keyof T]: T[K]["schema"] };
  return schemaValues(schemas);
}

export const HookHandlerSchema = z.discriminatedUnion(
  "kind",
  schemasFor(HookHandlerVariantRegistry),
);
export type HookHandler = z.infer<typeof HookHandlerSchema>;

const skillComponentSchema = z
  .object({
    kind: z.literal(ComponentKindRegistry.skill.tag),
    id: ComponentIdSchema,
    name: ClaimedSchema(z.string().min(1)),
    root: ClaimedSchema(z.string().min(1)),
    metadata: z.array(RetainedMetadataSchema).readonly(),
  })
  .strict()
  .readonly();

const hookComponentSchema = z
  .object({
    kind: z.literal(ComponentKindRegistry.hook.tag),
    id: ComponentIdSchema,
    event: ClaimedSchema(z.string().min(1)),
    matcher: ClaimedSchema(z.string()).optional(),
    handler: ClaimedSchema(HookHandlerSchema),
    metadata: z.array(RetainedMetadataSchema).readonly(),
  })
  .strict()
  .readonly();

const mcpServerComponentSchema = z
  .object({
    kind: z.literal(ComponentKindRegistry.mcpServer.tag),
    id: ComponentIdSchema,
    nativeKey: ClaimedSchema(z.string().min(1)),
    declaration: ClaimedSchema(JsonValueSchema),
    metadata: z.array(RetainedMetadataSchema).readonly(),
  })
  .strict()
  .readonly();

const foreignComponentSchema = z
  .object({
    kind: z.literal(ComponentKindRegistry.foreign.tag),
    id: ComponentIdSchema,
    nativeHost: NativeHostSchema,
    nativeKind: ClaimedSchema(z.string().min(1)),
    declarationSubkey: z.string().min(1),
    declaration: ClaimedSchema(JsonValueSchema),
  })
  .strict()
  .readonly();

const ComponentSchemaRegistry = {
  skill: skillComponentSchema,
  hook: hookComponentSchema,
  mcpServer: mcpServerComponentSchema,
  foreign: foreignComponentSchema,
} as const satisfies Record<keyof typeof ComponentKindRegistry, z.ZodTypeAny>;

export const SkillComponentSchema = ComponentSchemaRegistry.skill;
export type SkillComponent = z.infer<typeof SkillComponentSchema>;
export const HookComponentSchema = ComponentSchemaRegistry.hook;
export type HookComponent = z.infer<typeof HookComponentSchema>;
export const McpServerComponentSchema = ComponentSchemaRegistry.mcpServer;
export type McpServerComponent = z.infer<typeof McpServerComponentSchema>;
export const ForeignComponentSchema = ComponentSchemaRegistry.foreign;
export type ForeignComponent = z.infer<typeof ForeignComponentSchema>;

export const ComponentSchema = z.discriminatedUnion(
  "kind",
  schemaValues(ComponentSchemaRegistry),
);
export type Component = z.infer<typeof ComponentSchema>;

export const PluginComponentsSchema = z
  .object({
    skills: z.array(SkillComponentSchema).readonly(),
    hooks: z.array(HookComponentSchema).readonly(),
    mcpServers: z.array(McpServerComponentSchema).readonly(),
    foreign: z.array(ForeignComponentSchema).readonly(),
  })
  .strict()
  .readonly()
  .superRefine((components, context) => {
    const seen = new Map<string, string>();
    for (const [arrayName, values] of Object.entries(components)) {
      for (const [index, component] of values.entries()) {
        const firstArray = seen.get(component.id);
        if (firstArray !== undefined) {
          context.addIssue({
            code: "custom",
            path: [arrayName, index, "id"],
            message: `duplicate component id; first declared in ${firstArray}`,
          });
        } else {
          seen.set(component.id, `${arrayName}[${index}]`);
        }
      }
    }
  });
export type PluginComponents = z.infer<typeof PluginComponentsSchema>;

export function flattenComponents(
  components: PluginComponents,
): readonly Component[] {
  const valid = PluginComponentsSchema.parse(components);
  return [
    ...valid.skills,
    ...valid.hooks,
    ...valid.mcpServers,
    ...valid.foreign,
  ];
}
