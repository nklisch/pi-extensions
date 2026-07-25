/**
 * Package pack registration — v1 event contract and pure normalizer.
 *
 * Installed Pi packages contribute auto-reviewer data packs by listening for
 * {@link AUTO_REVIEWER_PACKS_REQUEST_EVENT} on the Pi event bus and emitting
 * {@link AUTO_REVIEWER_PACKS_REGISTER_EVENT} with an
 * {@link AutoReviewerPackRegistration} payload. This module is the stable,
 * author-facing contract: it exports the event names, API version, payload
 * types, and a total normalizer that turns an untrusted registration payload
 * into compiled package packs plus structured issues.
 *
 * Registration is discovery only. Package packs are available-but-disabled
 * until a user-owned enablement step opts them in; this normalizer never
 * enables a pack, fetches docs, resolves symlinks, or inspects package files.
 *
 * The normalizer is total: it returns issues and never throws, even for
 * adversarial input. Package identity lives on the registry
 * {@link PackSourceInfo}, not on `PolicyPack.metadata`.
 */

import type { RawPolicyPack } from "../config/schema.ts";
import type { PolicyPack } from "../policy/core.ts";
import { compilePack } from "../policy/core.ts";
import type { PackSourceInfo } from "./registry.ts";

/**
 * Stable API version for the v1 package-registration contract. Payloads with a
 * different `apiVersion` are rejected by the normalizer rather than interpreted.
 */
export const AUTO_REVIEWER_PACK_REGISTRATION_API_VERSION = 1 as const;

/**
 * Event the core extension emits on startup/reload to request pack
 * registrations from installed package contributors.
 */
export const AUTO_REVIEWER_PACKS_REQUEST_EVENT =
  "pi-auto-approve:packs:request" as const;

/**
 * Event a package contributor emits in response to a request (or unsolicited)
 * carrying an {@link AutoReviewerPackRegistration} payload.
 */
export const AUTO_REVIEWER_PACKS_REGISTER_EVENT =
  "pi-auto-approve:packs:register" as const;

/** How a contributing package was installed. Display provenance only. */
export type PackageInstallKind =
  | "npm"
  | "git"
  | "local"
  | "temporary"
  | "unknown";

/**
 * Package provenance supplied by the contributing package extension.
 *
 * This is untrusted display/audit data: it identifies where a pack came from
 * for registry listing and warnings, but it is not a trust decision and does
 * not enable any pack. The contributor supplies it because Pi does not hand
 * installed-package source metadata to event handlers.
 */
export interface AutoReviewerPackageProvenance {
  readonly name: string;
  readonly version?: string;
  readonly installKind: PackageInstallKind;
  readonly sourceSpec?: string;
  readonly packagePath?: string;
  readonly entrypointPath?: string;
}

/** Request payload for {@link AUTO_REVIEWER_PACKS_REQUEST_EVENT}. */
export interface AutoReviewerPackRegistrationRequest {
  readonly apiVersion: 1;
  readonly requestId: string;
  readonly reason: "startup" | "reload" | "manual";
}

/** A data-pack contribution: a raw JSON pack the normalizer compiles. */
export interface AutoReviewerDataPackContribution {
  readonly kind: "data-pack";
  readonly pack: RawPolicyPack;
}

/** A single package contribution: a data pack. */
export type AutoReviewerPackContribution = AutoReviewerDataPackContribution;

/** Full registration payload for {@link AUTO_REVIEWER_PACKS_REGISTER_EVENT}. */
export interface AutoReviewerPackRegistration {
  readonly apiVersion: 1;
  readonly requestId?: string;
  readonly package: AutoReviewerPackageProvenance;
  readonly packs: readonly AutoReviewerPackContribution[];
}

/**
 * A compiled data pack plus the package source info the registry records for it.
 * Rule provenance on every rule is rewritten to `source: "package"`.
 */
export interface NormalizedPackagePack {
  readonly pack: PolicyPack;
  readonly source: PackSourceInfo & { readonly kind: "package" };
}

/**
 * A structured registration issue. `path` is a JSON-pointer-style path rooted at
 * `$`. `packageName`/`packId`/`ruleId` are optional attribution for display.
 */
export interface PackageRegistrationIssue {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly packageName?: string;
  readonly packId?: string;
  readonly ruleId?: string;
  readonly path: string;
  readonly message: string;
}

/** Result of normalizing a registration payload. */
export interface PackageRegistrationResult {
  readonly packs: readonly NormalizedPackagePack[];
  readonly issues: readonly PackageRegistrationIssue[];
}

const PACKAGE_INSTALL_KINDS = [
  "npm",
  "git",
  "local",
  "temporary",
  "unknown",
] as const satisfies readonly PackageInstallKind[];

/**
 * Normalize an untrusted package-registration payload into compiled package
 * packs and structured issues.
 *
 * The function is total: it never throws. Valid `data-pack` contributions are
 * compiled with {@link compilePack} and every compiled rule's provenance is
 * rewritten to `{ source: "package", packId, ruleId }` regardless of the
 * package-supplied provenance, so decisions can later attribute back to a
 * package pack while detailed package metadata stays on the registry source.
 * Invalid payloads produce issues and contribute nothing.
 */
export function normalizePackagePackRegistration(
  registration: unknown,
): PackageRegistrationResult {
  try {
    return normalizeRegistration(registration);
  } catch (error) {
    return {
      packs: [],
      issues: [
        {
          severity: "error",
          code: "normalizer-error",
          path: "$",
          message: `normalizer error: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        },
      ],
    };
  }
}

function normalizeRegistration(
  registration: unknown,
): PackageRegistrationResult {
  const packs: NormalizedPackagePack[] = [];
  const issues: PackageRegistrationIssue[] = [];

  if (!isRecord(registration)) {
    issues.push(
      issue({
        severity: "error",
        code: "invalid-registration",
        path: "$",
        message: "expected registration object",
      }),
    );
    return { packs, issues };
  }

  if (registration.apiVersion !== AUTO_REVIEWER_PACK_REGISTRATION_API_VERSION) {
    issues.push(
      issue({
        severity: "error",
        code: "invalid-api-version",
        path: "$.apiVersion",
        message: `expected apiVersion ${AUTO_REVIEWER_PACK_REGISTRATION_API_VERSION}`,
      }),
    );
    // An unknown payload version has undefined semantics; do not attempt to
    // interpret packs or provenance from it.
    return { packs, issues };
  }

  const provenance = parseProvenance(registration.package, issues);
  if (provenance === null) {
    // Errors were recorded by parseProvenance; packs cannot be attributed.
    return { packs, issues };
  }

  const rawPacks = registration.packs;
  if (rawPacks === undefined) {
    // A package that contributes nothing is valid.
    return { packs, issues };
  }
  if (!Array.isArray(rawPacks)) {
    issues.push(
      issue({
        severity: "error",
        code: "invalid-packs",
        path: "$.packs",
        message: "expected packs array",
      }),
    );
    return { packs, issues };
  }

  rawPacks.forEach((contribution, index) => {
    normalizeContribution(
      contribution,
      provenance,
      `$.packs[${index}]`,
      packs,
      issues,
    );
  });

  return { packs, issues };
}

/**
 * Validate package provenance. A missing or invalid provenance aborts the
 * whole registration because packs cannot be attributed to a package source
 * without at least a name. Absent `installKind` defaults to `"unknown"` (the
 * enum is purpose-built for that fallback); optional display fields must be
 * absent or non-empty strings so contributors do not publish ambiguous blank
 * provenance values.
 */
function parseProvenance(
  raw: unknown,
  issues: PackageRegistrationIssue[],
): AutoReviewerPackageProvenance | null {
  if (!isRecord(raw)) {
    issues.push(
      issue({
        severity: "error",
        code: "invalid-package-provenance",
        path: "$.package",
        message: "expected package provenance object",
      }),
    );
    return null;
  }

  if (!isNonEmptyString(raw.name)) {
    issues.push(
      issue({
        severity: "error",
        code: "missing-package-name",
        path: "$.package.name",
        message: "expected non-empty package name",
      }),
    );
    return null;
  }

  let installKind: PackageInstallKind;
  if (raw.installKind === undefined) {
    installKind = "unknown";
  } else if (isPackageInstallKind(raw.installKind)) {
    installKind = raw.installKind;
  } else {
    issues.push(
      issue({
        severity: "error",
        code: "invalid-package-provenance",
        path: "$.package.installKind",
        message: "invalid installKind",
      }),
    );
    return null;
  }

  const version = optionalNonEmptyString(raw.version);
  if (version === null) {
    issues.push(
      issue({
        severity: "error",
        code: "invalid-package-provenance",
        path: "$.package.version",
        message: "expected string package version",
      }),
    );
    return null;
  }
  const sourceSpec = optionalNonEmptyString(raw.sourceSpec);
  if (sourceSpec === null) {
    issues.push(
      issue({
        severity: "error",
        code: "invalid-package-provenance",
        path: "$.package.sourceSpec",
        message: "expected string source spec",
      }),
    );
    return null;
  }
  const packagePath = optionalNonEmptyString(raw.packagePath);
  if (packagePath === null) {
    issues.push(
      issue({
        severity: "error",
        code: "invalid-package-provenance",
        path: "$.package.packagePath",
        message: "expected string package path",
      }),
    );
    return null;
  }
  const entrypointPath = optionalNonEmptyString(raw.entrypointPath);
  if (entrypointPath === null) {
    issues.push(
      issue({
        severity: "error",
        code: "invalid-package-provenance",
        path: "$.package.entrypointPath",
        message: "expected string entrypoint path",
      }),
    );
    return null;
  }

  return {
    name: raw.name,
    installKind,
    ...(version === undefined ? {} : { version }),
    ...(sourceSpec === undefined ? {} : { sourceSpec }),
    ...(packagePath === undefined ? {} : { packagePath }),
    ...(entrypointPath === undefined ? {} : { entrypointPath }),
  };
}

function normalizeContribution(
  contribution: unknown,
  provenance: AutoReviewerPackageProvenance,
  base: string,
  packs: NormalizedPackagePack[],
  issues: PackageRegistrationIssue[],
): void {
  if (!isRecord(contribution)) {
    issues.push(
      issue({
        severity: "error",
        code: "invalid-contribution",
        path: base,
        message: "expected contribution object",
        packageName: provenance.name,
      }),
    );
    return;
  }

  const kind = contribution.kind;
  if (kind === "data-pack") {
    normalizeDataPack(contribution, provenance, base, packs, issues);
    return;
  }
  issues.push(
    issue({
      severity: "error",
      code:
        kind === undefined
          ? "missing-contribution-kind"
          : "unknown-contribution-kind",
      path: `${base}.kind`,
      message:
        kind === undefined
          ? "expected contribution kind"
          : `unknown contribution kind ${String(kind)}`,
      packageName: provenance.name,
    }),
  );
}

function normalizeDataPack(
  contribution: Record<string, unknown>,
  provenance: AutoReviewerPackageProvenance,
  base: string,
  packs: NormalizedPackagePack[],
  issues: PackageRegistrationIssue[],
): void {
  const packBase = `${base}.pack`;
  const result = compilePack(contribution.pack);
  if (result.pack === null) {
    for (const error of result.errors) {
      issues.push(
        issue({
          severity: "error",
          code: "invalid-data-pack",
          packageName: provenance.name,
          packId: error.packId,
          ruleId: error.ruleId,
          path: joinPath(packBase, error.path),
          message: error.message,
        }),
      );
    }
    return;
  }

  const compiled = result.pack;
  // Rewrite every compiled rule's provenance to the package source, preserving
  // the compiled packId/ruleId. Package-supplied provenance is discarded so a
  // contributed pack cannot masquerade as shipped/user policy. Inert metadata
  // and docs links are preserved verbatim via the pack spread.
  const rewrittenPack: PolicyPack = {
    ...compiled,
    rules: compiled.rules.map((rule) => ({
      ...rule,
      provenance: {
        source: "package",
        packId: rule.provenance.packId ?? compiled.id,
        ruleId: rule.provenance.ruleId ?? rule.id,
      },
    })),
  };

  packs.push({ pack: rewrittenPack, source: buildPackageSource(provenance) });
}

function buildPackageSource(
  provenance: AutoReviewerPackageProvenance,
): PackSourceInfo & { readonly kind: "package" } {
  return {
    kind: "package",
    packageName: provenance.name,
    packageInstallKind: provenance.installKind,
    ...(provenance.version === undefined
      ? {}
      : { packageVersion: provenance.version }),
    ...(provenance.sourceSpec === undefined
      ? {}
      : { packageSourceSpec: provenance.sourceSpec }),
    ...(provenance.packagePath === undefined
      ? {}
      : { packagePath: provenance.packagePath }),
    ...(provenance.entrypointPath === undefined
      ? {}
      : { packageEntrypointPath: provenance.entrypointPath }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPackageInstallKind(value: unknown): value is PackageInstallKind {
  return PACKAGE_INSTALL_KINDS.some((kind) => kind === value);
}

/**
 * Returns the string if it is a non-empty string, `undefined` if absent, or
 * `null` if present but not a valid non-empty string (the caller reports an
 * issue). This tri-state keeps optional-field validation total and explicit.
 */
function optionalNonEmptyString(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (isNonEmptyString(value)) {
    return value;
  }
  return null;
}

/** Join a base JSON path with a compile-error path. "$" means the base itself. */
function joinPath(base: string, path: string): string {
  if (path === "$" || path.length === 0) {
    return base;
  }
  return `${base}.${path}`;
}

function issue(params: {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly packageName?: string;
  readonly packId?: string | null;
  readonly ruleId?: string | null;
}): PackageRegistrationIssue {
  return {
    severity: params.severity,
    code: params.code,
    path: params.path,
    message: params.message,
    ...(params.packageName === undefined
      ? {}
      : { packageName: params.packageName }),
    ...(params.packId === undefined || params.packId === null
      ? {}
      : { packId: params.packId }),
    ...(params.ruleId === undefined || params.ruleId === null
      ? {}
      : { ruleId: params.ruleId }),
  };
}
