import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

export const RATCHET_TOOL_PREFIX = "clearance_";

export interface RatchetToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: TSchema;
  readonly execute: ToolDefinition["execute"];
}

export interface RatchetModeStatus {
  readonly active: boolean;
  readonly previousActiveTools: readonly string[];
  readonly ratchetToolNames: readonly string[];
}

export interface RatchetModeFallback {
  readonly kind: "tools-changed";
  readonly restored: readonly string[];
  readonly expected: readonly string[];
  readonly actual: readonly string[];
  readonly message: string;
}

export interface RatchetModeResult {
  readonly ok: boolean;
  readonly status: RatchetModeStatus;
  readonly message: string;
  readonly fallback?: RatchetModeFallback;
}

export interface RatchetModeManager {
  readonly isRatchetActive: () => boolean;
  readonly getStatus: () => RatchetModeStatus;
  readonly registerRatchetTool: (tool: RatchetToolDefinition) => void;
  readonly enterRatchetMode: (
    pi: Pick<
      ExtensionAPI,
      "getActiveTools" | "getAllTools" | "setActiveTools" | "registerTool"
    >,
  ) => RatchetModeResult;
  readonly exitRatchetMode: (
    pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  ) => RatchetModeResult;
}

/** Preserve first-seen order while deduplicating tool names. */
function stableUnique(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }

  return unique;
}

function stableUnion(...groups: readonly (readonly string[])[]): string[] {
  return stableUnique(groups.flat());
}

function haveSameMembers(
  leftNames: readonly string[],
  rightNames: readonly string[],
): boolean {
  const left = new Set(leftNames);
  const right = new Set(rightNames);
  if (left.size !== right.size) return false;

  for (const name of left) {
    if (!right.has(name)) return false;
  }

  return true;
}

function ratchetModeOnMessage(
  activatedCount: number,
  skippedNames: readonly string[],
): string {
  const base =
    activatedCount === 1
      ? "Ratchet mode is on; activated 1 ratchet tool."
      : `Ratchet mode is on; activated ${activatedCount} ratchet tools.`;

  if (skippedNames.length === 0) {
    return base;
  }

  return `${base} Warning: skipped ratchet tools: ${skippedNames.join(", ")}.`;
}

/**
 * Bridge Pi's public `typebox` type import with this package's `@sinclair/typebox`
 * convention. The schema objects are runtime-compatible; this cast is kept at the Pi edge.
 */
function asPiToolDefinition(tool: RatchetToolDefinition): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

/** Create an in-memory, per-extension-instance ratchet mode manager. */
export function createRatchetModeManager(): RatchetModeManager {
  let active = false;
  let previousActiveTools: readonly string[] = [];
  let activeRatchetToolNames: readonly string[] = [];
  const ratchetToolsByName = new Map<string, RatchetToolDefinition>();
  const registeredToolsByName = new Map<string, RatchetToolDefinition>();

  const ratchetToolNames = (): string[] => [...ratchetToolsByName.keys()];

  const status = (): RatchetModeStatus => ({
    active,
    previousActiveTools: [...previousActiveTools],
    ratchetToolNames: ratchetToolNames(),
  });

  return {
    isRatchetActive: () => active,

    getStatus: status,

    registerRatchetTool(tool) {
      ratchetToolsByName.set(tool.name, tool);
    },

    enterRatchetMode(pi) {
      if (active) {
        return {
          ok: true,
          status: status(),
          message: "Ratchet mode is already on.",
        };
      }

      const names = ratchetToolNames();
      const ratchetNameSet = new Set(names);
      // A prior extension instance may have left ratchet tools active across a
      // reload/session switch. They are ratchet-owned even if already active, so
      // never treat them as part of the user's pre-mode tool set to restore.
      const snapshot = pi
        .getActiveTools()
        .filter((name) => !ratchetNameSet.has(name));
      const preExistingToolNames = new Set(
        pi.getAllTools().map((tool) => tool.name),
      );
      const skippedNames: string[] = [];
      const activatableTools: RatchetToolDefinition[] = [];

      for (const tool of ratchetToolsByName.values()) {
        const alreadyRegisteredByManager =
          registeredToolsByName.get(tool.name) === tool;
        if (
          !tool.name.startsWith(RATCHET_TOOL_PREFIX) ||
          (preExistingToolNames.has(tool.name) && !alreadyRegisteredByManager)
        ) {
          skippedNames.push(tool.name);
          continue;
        }

        activatableTools.push(tool);

        if (alreadyRegisteredByManager) continue;

        pi.registerTool(asPiToolDefinition(tool));
        registeredToolsByName.set(tool.name, tool);
      }

      const activatedNames = activatableTools.map((tool) => tool.name);
      pi.setActiveTools(stableUnion(snapshot, activatedNames));
      previousActiveTools = snapshot;
      activeRatchetToolNames = activatedNames;
      active = true;

      return {
        ok: true,
        status: status(),
        message: ratchetModeOnMessage(activatedNames.length, skippedNames),
      };
    },

    exitRatchetMode(pi) {
      if (!active) {
        return {
          ok: true,
          status: status(),
          message: "Ratchet mode is already off.",
        };
      }

      const currentActiveTools = [...pi.getActiveTools()];
      const names = [...activeRatchetToolNames];
      const expected = stableUnion(previousActiveTools, names);
      const ratchetNameSet = new Set(names);

      let restored: readonly string[];
      let fallback: RatchetModeFallback | undefined;
      let message: string;

      if (haveSameMembers(currentActiveTools, expected)) {
        restored = [...previousActiveTools];
        message = "Ratchet mode is off; restored previous tools.";
      } else {
        restored = currentActiveTools.filter(
          (name) => !ratchetNameSet.has(name),
        );
        const fallbackMessage =
          "Active tools changed while ratchet mode was on; removed ratchet tools and preserved current non-ratchet tools.";
        fallback = {
          kind: "tools-changed",
          restored,
          expected,
          actual: currentActiveTools,
          message: fallbackMessage,
        };
        message =
          "Ratchet mode is off; active tools changed, so ratchet tools were removed without exact restore.";
      }

      pi.setActiveTools([...restored]);
      previousActiveTools = [];
      activeRatchetToolNames = [];
      active = false;

      return {
        ok: true,
        status: status(),
        message,
        ...(fallback === undefined ? {} : { fallback }),
      };
    },
  };
}
