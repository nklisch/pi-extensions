import {
  NativeControlCommandRegistry,
  type NativeControlCommandId,
} from "../../application/native-control-registry.js";
import type { PluginManagerRow, PluginManagerView } from "./plugin-manager-model.js";

type OptionValue = string | number | boolean | readonly string[] | undefined;

function optionName(command: NativeControlCommandId, key: string): string {
  const option = NativeControlCommandRegistry[command].options.find((candidate) => candidate.key === key);
  if (option === undefined) throw new TypeError(`control option ${key} is not registered on ${command}`);
  return option.name;
}

/** Serialize typed UI intent through the facade registry, never a copied path table. */
export function nativeControlArgv(
  command: NativeControlCommandId,
  positionals: readonly string[] = [],
  options: Readonly<Record<string, OptionValue>> = {},
): readonly string[] {
  const definition = NativeControlCommandRegistry[command];
  const argv = [...definition.path, ...positionals];
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === false) continue;
    const name = optionName(command, key);
    if (value === true) {
      argv.push(name);
    } else if (Array.isArray(value)) {
      for (const entry of value) argv.push(name, entry);
    } else {
      argv.push(name, String(value));
    }
  }
  return Object.freeze(argv);
}

export function pageCommand(input: Readonly<{
  view: PluginManagerView | "browse";
  query: string;
  next?: string;
}>): readonly string[] {
  if (input.view === "installed") {
    return nativeControlArgv("inspection.list", [], {
      scope: "all-current",
      query: input.query,
      cursor: input.next,
      limit: 50,
    });
  }
  if (input.view === "browse") {
    return nativeControlArgv("browse", input.query.length === 0 ? [] : [input.query], {
      scope: "all-current",
      cursor: input.next,
      limit: 50,
    });
  }
  return nativeControlArgv("marketplace.list", [], { limit: 50 });
}

/** Update notices never render as rows; they feed the catalog's update flags and counts. */
export function updateNoticesCommand(next?: string): readonly string[] {
  return nativeControlArgv("updates.notices.list", [], {
    scope: "all-current",
    after: next,
    limit: 50,
  });
}

/** Host health shows as a heading indicator, not a view; diagnostics stay on /plugin doctor. */
export function hostStatusCommand(): readonly string[] {
  return nativeControlArgv("status");
}

export function updateStatusCommand(): readonly string[] {
  return nativeControlArgv("updates.status", [], { scope: "all-current" });
}

export type UpdatePolicySetChange =
  | Readonly<{ policyKind: "application"; policyMode: "manual" | "automatic" }>
  | Readonly<{ policyKind: "cadence"; cadence: "paused" | "conservative" | "balanced" | "frequent" }>;

/** Global policy changes serialize through the registry like every other UI intent. */
export function updatePolicySetCommand(
  change: UpdatePolicySetChange,
  exact?: Readonly<{ previewId: string; consentId?: string }>,
): readonly string[] {
  return nativeControlArgv("updates.policy.set", [], {
    policyKind: change.policyKind,
    policyTarget: "global",
    ...(change.policyKind === "application" ? { policyMode: change.policyMode } : { cadence: change.cadence }),
    previewId: exact?.previewId,
    consentId: exact?.consentId,
  });
}

export function detailCommand(row: PluginManagerRow): readonly string[] | undefined {
  if (row.key.subject === "installed" && row.plugin !== undefined && row.scope !== undefined &&
      row.key.snapshotId !== undefined && row.key.detailId !== undefined) {
    return nativeControlArgv("inspection.show", [row.plugin], {
      scope: row.scope,
      snapshotId: row.key.snapshotId,
      detailId: row.key.detailId,
    });
  }
  if (row.key.subject === "candidate" && row.plugin !== undefined && row.scope !== undefined) {
    return nativeControlArgv("inspection.show", [row.plugin], { scope: row.scope });
  }
  return undefined;
}
