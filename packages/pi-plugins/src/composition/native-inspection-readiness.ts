import { compareUtf8 } from "../domain/canonical-json.js";
import { PluginConfigurationSchema, type ConfigurationOption } from "../domain/configuration.js";
import { verifyPluginConfigurationDocument } from "../domain/configured-values.js";
import { evaluateTrust, verifyTrustCandidate } from "../domain/trust-policy.js";
import { ScopeReferenceSchema } from "../domain/state/scope.js";
import type { LifecycleStateStore } from "../application/ports/lifecycle-state-store.js";
import type { PluginConfigurationStore } from "../application/ports/plugin-configuration-store.js";
import type { ProjectTrustPort } from "../application/ports/project-trust.js";
import type { Sha256 } from "../domain/source.js";
import type { HostCapabilityStatus } from "../application/host-observation-contract.js";
import { NativeConfigurationOptionViewSchema, type NativeConfigurationOptionView } from "../application/native-inspection-contract.js";
import { NativeDisplayLimits, toSafeDisplayField } from "../application/native-inspection-display.js";
import type { InspectionReadinessPort } from "../application/ports/inspection-readiness.js";

function hasDefault(option: ConfigurationOption): boolean {
  return "default" in option.value && option.value.default !== undefined;
}

function sameScope(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Read trust/configuration presence without returning values, locators, roots, or stores. */
export function createNativeInspectionReadiness(input: Readonly<{
  state: LifecycleStateStore;
  configurations: PluginConfigurationStore;
  projectTrust: ProjectTrustPort;
  secretCustody: HostCapabilityStatus;
  sha256: Sha256;
}>): InspectionReadinessPort {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function") {
    throw new TypeError("native inspection readiness dependencies are required");
  }
  const custody = Object.freeze({ ...input.secretCustody });

  const port: InspectionReadinessPort = {
    async trust(candidateInput, scopeInput, signal) {
      signal.throwIfAborted();
      const scope = ScopeReferenceSchema.parse(scopeInput);
      let candidate;
      try {
        candidate = verifyTrustCandidate(candidateInput, input.sha256);
      } catch {
        return "invalid-evidence";
      }
      if (!sameScope(scope, candidate.evidence.scope)) return "invalid-evidence";
      if (scope.kind === "project") {
        try {
          if ((await input.projectTrust.assess(scope.projectKey, signal)).kind !== "trusted") return "project-untrusted";
        } catch (error) {
          if (signal.aborted) throw error;
          return "unavailable";
        }
      }
      let state;
      try {
        state = await input.state.read({ kind: "user" }, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        return "unavailable";
      }
      if (!state.ok || !("trust" in state.snapshot)) return "unavailable";
      const decision = evaluateTrust(candidate, state.snapshot.trust.records, input.sha256);
      if (decision.kind === "authorized") return "authorized";
      if (decision.reason === "ABSENT") return "required";
      if (decision.reason === "REVOKED") return "revoked";
      return "invalid-evidence";
    },

    async configuration(request, signal): Promise<readonly NativeConfigurationOptionView[]> {
      signal.throwIfAborted();
      const descriptors = PluginConfigurationSchema.parse(request.descriptors);
      const scope = ScopeReferenceSchema.parse(request.scope);
      let configured = new Set<string>();
      let documentState: "ready" | "missing" | "unavailable" | "invalid" = request.configurationRef === undefined ? "missing" : "ready";
      if (request.configurationRef !== undefined) {
        try {
          const result = await input.configurations.read(request.configurationRef, signal);
          if (result.kind === "missing") {
            documentState = "missing";
          } else {
            try {
              const document = verifyPluginConfigurationDocument(result.document, descriptors, input.sha256);
              if (document.configurationRef !== request.configurationRef || document.plugin !== request.plugin || !sameScope(document.scope, scope)) {
                documentState = "invalid";
              } else {
                configured = new Set([...document.values.map((entry) => entry.key), ...document.secrets.map((entry) => entry.key)]);
              }
            } catch {
              documentState = "invalid";
            }
          }
        } catch (error) {
          if (signal.aborted) throw error;
          documentState = "unavailable";
        }
      }

      const views = descriptors.options.map((option) => {
        let state: NativeConfigurationOptionView["state"];
        if (documentState === "invalid") state = "invalid";
        else if (documentState === "unavailable") state = "unavailable";
        else if (configured.has(option.key)) state = option.sensitive && custody.status === "unavailable" ? "unavailable" : "configured";
        else if (hasDefault(option)) state = "defaulted";
        else if (option.sensitive && custody.status === "unavailable") state = "unavailable";
        else state = "missing";
        return NativeConfigurationOptionViewSchema.parse({
          key: option.key,
          label: toSafeDisplayField(option.label.value, { maxScalars: NativeDisplayLimits.labelScalars }),
          valueKind: option.value.kind,
          required: option.required,
          sensitive: option.sensitive,
          defaultPresent: hasDefault(option),
          state,
        });
      }).sort((left, right) => compareUtf8(left.key, right.key));
      return Object.freeze(views);
    },
    secretCustody: () => custody,
  };
  return Object.freeze(port);
}
