import { z } from "zod";

export const ProjectIntentWriteIdSchema = z.string()
  .regex(/^project-intent-write-v1:[A-Za-z0-9_-]{32}$/)
  .brand<"ProjectIntentWriteId">();
export type ProjectIntentWriteId = z.infer<typeof ProjectIntentWriteIdSchema>;

export interface ProjectIntentWriteIdPort {
  create(signal: AbortSignal): Promise<ProjectIntentWriteId>;
}
