import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  buildDefaultPackListingReport,
  buildPackDossierReport,
} from "../../packs.ts";
import type { CommandReport } from "../../types.ts";
import { resolvePolicyReport } from "../../types.ts";
import type { SettingsAction } from "../actions.ts";
import type { SettingsDispatchDependencies } from "../dispatcher.ts";
import type { SettingsPanel, SettingsRow } from "../panels.ts";
import type { SettingsReadModel } from "../read-model.ts";

export const PACKS_PANEL: SettingsPanel = {
  id: "packs",
  title: "Pack explorer",
  rows: packsRows,
  actions: ["packs.open", "packs.show", "packs.enable", "packs.disable"],
};

export function packsRows(model: SettingsReadModel): readonly SettingsRow[] {
  return [
    {
      label: "Pack explorer",
      value: `${model.status.packs.enabled}/${model.status.packs.total} enabled`,
      meaning:
        "Installed packs are discoverable here; enabling remains explicit.",
    },
  ];
}

export async function renderPacksOpenDrill(input: {
  readonly action: SettingsAction;
  readonly ctx: ExtensionCommandContext;
  readonly deps: SettingsDispatchDependencies;
}): Promise<CommandReport> {
  const policy = await resolvePolicyReport(input.ctx, input.deps);
  if (!policy.ok) {
    return policy.report;
  }

  const listing = buildDefaultPackListingReport({ policy: policy.policy });

  return {
    title: "Pack explorer settings",
    summary: `${listing.summary} Navigation only; no config changes were written.`,
    markdown: [
      listing.markdown,
      "",
      "## Actions",
      "- Show a dossier: `packs.show` with `packId`.",
      "- Enable a package/config pack: `packs.enable` with `packId` and optional `scope` (`global` or `project`).",
      "- Disable a package/config pack: `packs.disable` with `packId` and optional `scope` (`global` or `project`).",
      "- Package packs are only available after install; enablement writes user-owned config after confirmation.",
      "",
      "Navigation only; no config changes were written.",
    ].join("\n"),
    details: {
      reason: "navigation",
      action: input.action,
      panel: "Pack explorer",
      listing: listing.details,
      actions: PACKS_PANEL.actions,
    },
    level: listing.level ?? "info",
  };
}

export async function renderPacksShowDrill(input: {
  readonly action: SettingsAction;
  readonly ctx: ExtensionCommandContext;
  readonly deps: SettingsDispatchDependencies;
}): Promise<CommandReport> {
  const packId = input.action.args.packId;
  if (typeof packId !== "string" || packId.trim().length === 0) {
    return {
      title: "Pack lookup failed",
      summary:
        "Settings action `packs.show` requires packId: a non-empty pack id.",
      markdown: [
        "# Pack lookup failed",
        "",
        "- Settings action `packs.show` requires packId: a non-empty pack id.",
        "- Navigation only; no config changes were written.",
      ].join("\n"),
      details: {
        reason: "invalid-action",
        action: input.action,
        panel: "Pack explorer",
      },
      level: "error",
    };
  }

  const policy = await resolvePolicyReport(input.ctx, input.deps);
  if (!policy.ok) {
    return policy.report;
  }

  const dossier = buildPackDossierReport({
    policy: policy.policy,
    packId,
  });

  return {
    ...dossier,
    summary: `${dossier.summary} Navigation only; no config changes were written.`,
    markdown: [
      dossier.markdown,
      "",
      "Navigation only; no config changes were written.",
    ].join("\n"),
    details: {
      reason: "navigation",
      action: input.action,
      panel: "Pack explorer",
      dossier: dossier.details,
    },
  };
}
