import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  createAdoptionService,
  type AdoptionService,
} from "../application/adoption-service.js";
import type { AdoptionReaderRegistry } from "../application/adoption-contract.js";
import type { MarketplaceRegistrationPort } from "../application/ports/marketplace-registration.js";
import type { MarketplaceAdoptionRegistryPort } from "../application/adoption-service.js";
import { readClaudeKnownMarketplacesJson, readClaudeUserSettingsJson } from "../formats/claude/state-reader.js";
import { readCodexUserConfigToml } from "../formats/codex/state-reader.js";
import { createNodeForeignStateFiles } from "../infrastructure/adoption/node-foreign-state-files.js";

export type NodeAdoptionServiceOptions = Readonly<{
  registrations: MarketplaceRegistrationPort;
  registry?: MarketplaceAdoptionRegistryPort;
  userHome?: string;
  claudeRoot?: string;
  codexHome?: string;
  maxDocumentBytes?: number;
}>;

const readers: AdoptionReaderRegistry = {
  "claude-known-marketplaces": readClaudeKnownMarketplacesJson,
  "claude-user-settings": readClaudeUserSettingsJson,
  "codex-user-config": readCodexUserConfigToml,
};

const nodeSha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

export function createNodeAdoptionService(
  options: NodeAdoptionServiceOptions,
): AdoptionService {
  if (options === null || typeof options !== "object" || options.registrations === undefined) {
    throw new TypeError("createNodeAdoptionService requires a marketplace registration port");
  }
  const userHome = options.userHome ?? homedir();
  return createAdoptionService({
    files: createNodeForeignStateFiles({
      userHome,
      ...(options.claudeRoot === undefined ? {} : { claudeRoot: options.claudeRoot }),
      ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
      ...(options.maxDocumentBytes === undefined ? {} : { maxDocumentBytes: options.maxDocumentBytes }),
    }),
    readers,
    registrations: options.registrations,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    sha256: nodeSha256,
  });
}
