import {
  removePluginConfiguration,
  savePluginConfiguration,
  type BoundPluginConfigurationService,
} from "../application/configuration-service.js";
import { withResolvedPluginConfiguration } from "../application/configuration-resolver.js";
import type { ConfigurationPathPort } from "../application/ports/configuration-path.js";
import type { ConfigurationWriteIdPort } from "../application/ports/configuration-write-id.js";
import type { PluginConfigurationStore } from "../application/ports/plugin-configuration-store.js";
import type { ProjectRootAuthorityPort } from "../application/ports/project-root-authority.js";
import type { ProjectTrustPort } from "../application/ports/project-trust.js";
import type { SecretStore } from "../application/ports/secret-store.js";
import type { Sha256 } from "../domain/source.js";

export type HostConfigurationDependencies = Readonly<{
  withResolvedPluginConfiguration: typeof withResolvedPluginConfiguration;
  dependencies: Parameters<typeof withResolvedPluginConfiguration>[1];
}>;

/** Bind safe application operations and private callback-scoped resolution once. */
export function createHostConfigurationServices(input: Readonly<{
  configurations: PluginConfigurationStore;
  secrets: SecretStore;
  paths: ConfigurationPathPort;
  projectRoots: ProjectRootAuthorityPort;
  projectTrust: ProjectTrustPort;
  writeIds: ConfigurationWriteIdPort;
  sha256: Sha256;
}>): Readonly<{
  application: BoundPluginConfigurationService;
  execution: HostConfigurationDependencies;
}> {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function") {
    throw new TypeError("host configuration dependencies are required");
  }
  const application: BoundPluginConfigurationService = Object.freeze({
    save: (request, signal) => savePluginConfiguration(request, {
      configurations: input.configurations,
      secrets: input.secrets,
      paths: input.paths,
      writeIds: input.writeIds,
      projectRoots: input.projectRoots,
      sha256: input.sha256,
    }, signal),
    remove: (request, signal) => removePluginConfiguration(request, {
      configurations: input.configurations,
      secrets: input.secrets,
      projectRoots: input.projectRoots,
      sha256: input.sha256,
    }, signal),
  });
  const execution: HostConfigurationDependencies = Object.freeze({
    withResolvedPluginConfiguration,
    dependencies: Object.freeze({
      projectTrust: input.projectTrust,
      configurations: input.configurations,
      secrets: input.secrets,
      paths: input.paths,
      projectRoots: input.projectRoots,
      sha256: input.sha256,
    }),
  });
  return Object.freeze({ application, execution });
}
