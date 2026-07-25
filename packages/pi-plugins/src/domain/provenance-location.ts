import { z } from "zod";

export const NativeHostSchema = z.enum(["claude", "codex"]);
export type NativeHost = z.infer<typeof NativeHostSchema>;

export const SourceDocumentKindSchema = z.enum([
  "marketplace",
  "manifest",
  "hooks",
  "mcp",
  "skill",
  "convention",
  "foreign-state",
]);
export type SourceDocumentKind = z.infer<typeof SourceDocumentKindSchema>;

const JsonPointerSchema = z.string().refine(
  (value) =>
    value === "" ||
    /^\/(?:[^~/]|~[01])*(?:\/(?:[^~/]|~[01])*)*$/.test(value),
  "JSON Pointer must use RFC 6901 reference-token escaping",
);

export const SourceLocationSchema = z
  .object({
    host: NativeHostSchema,
    documentKind: SourceDocumentKindSchema,
    path: z.string().min(1),
    // RFC 6901 uses the empty string for the document root. In non-root
    // pointers every `~` must begin a `~0` or `~1` escape; `/` separates
    // reference tokens and an empty token is valid (`/`).
    pointer: JsonPointerSchema.optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict()
  .readonly();
export type SourceLocation = z.infer<typeof SourceLocationSchema>;
