import { isAbsolute, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PackagedPluginHostError,
  PackagedPluginHostErrorCode,
  type PiSessionBinding,
  type PiSessionBindingPort,
} from "../composition/packaged-plugin-host-contract.js";

function mismatch(): never {
  throw new PackagedPluginHostError(
    PackagedPluginHostErrorCode.sessionMismatch,
    "Pi context does not belong to the bound host session",
  );
}

function readSessionId(context: ExtensionContext): string {
  const value = context.sessionManager.getSessionId();
  if (typeof value !== "string" || value.length === 0) mismatch();
  return value;
}

/** Bind one started host to the exact Pi context that selected its project. */
export function createPiSessionBinding(context: ExtensionContext): PiSessionBindingPort {
  if (context === null || typeof context !== "object") mismatch();
  const sessionId = readSessionId(context);
  if (typeof context.cwd !== "string" || context.cwd.length === 0 || !isAbsolute(context.cwd)) mismatch();
  const cwd = resolve(context.cwd);
  if (cwd !== context.cwd) mismatch();
  const sessionFile = context.sessionManager.getSessionFile();
  if (sessionFile !== undefined && (typeof sessionFile !== "string" || sessionFile.length === 0)) mismatch();
  const projectTrusted = context.isProjectTrusted();
  if (typeof projectTrusted !== "boolean") mismatch();

  const binding: PiSessionBinding = Object.freeze({
    sessionId,
    ...(sessionFile === undefined ? {} : { sessionFile }),
    cwd,
    mode: context.mode,
    projectTrusted,
  });

  return Object.freeze({
    current(): PiSessionBinding {
      return binding;
    },
    assertContext(candidate: ExtensionContext): void {
      if (candidate === null || typeof candidate !== "object") mismatch();
      let candidateId: string;
      try {
        candidateId = readSessionId(candidate);
      } catch {
        mismatch();
      }
      if (candidateId !== binding.sessionId || candidate.cwd !== binding.cwd) mismatch();
    },
    isProjectTrusted(): boolean {
      // Trust is live policy evidence. It must not be inferred from the startup
      // value retained only for status/audit output.
      return context.isProjectTrusted() === true;
    },
  });
}
