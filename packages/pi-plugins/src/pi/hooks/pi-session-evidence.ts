import { CurrentProjectRuntimeContextSchema, type CurrentProjectRuntimeContext } from "../../application/ports/project-trust.js";
import { HookSessionEvidenceSchema, type HookSessionEvidence } from "../../runtime/hooks/event-contract.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function readPiSessionEvidence(ctx: ExtensionContext, currentProject: CurrentProjectRuntimeContext): HookSessionEvidence {
  const project = CurrentProjectRuntimeContextSchema.parse(currentProject);
  const sessionFile = ctx.sessionManager.getSessionFile();
  return HookSessionEvidenceSchema.parse({
    sessionId: ctx.sessionManager.getSessionId(),
    ...(sessionFile === undefined ? {} : { transcriptPath: sessionFile }),
    cwd: ctx.cwd,
    currentProject: project,
    piProjectTrusted: ctx.isProjectTrusted(),
  });
}

export function lastAssistantText(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as unknown as { type?: string; message?: { role?: string; content?: readonly unknown[] } };
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const text = (entry.message.content ?? []).filter((item): item is { type: "text"; text: string } => {
      return item !== null && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string";
    }).map((item) => item.text).filter((value) => value.length > 0).join("\n");
    if (text.length > 0) return text;
  }
  return undefined;
}
