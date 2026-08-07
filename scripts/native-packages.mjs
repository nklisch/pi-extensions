import { existsSync } from "node:fs";
import { join } from "node:path";

const TARGETS = new Map([
  ["x86_64-unknown-linux-gnu", "linux-x64-gnu"],
  ["aarch64-unknown-linux-gnu", "linux-arm64-gnu"],
  ["x86_64-apple-darwin", "darwin-x64"],
  ["aarch64-apple-darwin", "darwin-arm64"],
  ["x86_64-pc-windows-msvc", "win32-x64-msvc"],
  ["aarch64-pc-windows-msvc", "win32-arm64-msvc"],
]);

/** Derive the release artifacts declared by one napi-rs package manifest. */
export function nativeArtifactDescriptors(pkg) {
  const napi = pkg.manifest.napi;
  if (napi === undefined) return [];
  if (typeof napi.binaryName !== "string" || !Array.isArray(napi.targets)) {
    throw new Error(`${pkg.manifest.name}: napi.binaryName and napi.targets are required`);
  }

  return napi.targets.map((target) => {
    const suffix = TARGETS.get(target);
    if (suffix === undefined) {
      throw new Error(`${pkg.manifest.name}: unsupported napi target ${target}`);
    }
    const binaryFile = `${napi.binaryName}.${suffix}.node`;
    return {
      target,
      suffix,
      binaryFile,
      artifactPath: join(pkg.directory, "native", binaryFile),
    };
  });
}

/** Validate source-controlled contracts without requiring cross-built artifacts. */
export function validateNativePackageContract(pkg) {
  const descriptors = nativeArtifactDescriptors(pkg);
  if (descriptors.length === 0) return [];

  const errors = [];
  const files = pkg.manifest.files ?? [];
  if (!files.includes("native") && !files.includes("native/")) {
    errors.push("files must include native so release-built artifacts are published");
  }

  // Native artifacts are intentionally part of the existing package. Creating
  // platform package names makes an OIDC-only release impossible to bootstrap.
  for (const name of Object.keys(pkg.manifest.optionalDependencies ?? {})) {
    if (name.startsWith(`${pkg.manifest.name}-`)) {
      errors.push(`native artifact must not be delegated to package ${name}`);
    }
  }

  return errors;
}

/** Fail a release unless every declared target was staged by CI. */
export function requireNativeArtifacts(pkg) {
  const errors = validateNativePackageContract(pkg);
  if (errors.length > 0) {
    throw new Error(`${pkg.manifest.name}: invalid native package contract: ${errors.join("; ")}`);
  }

  const missing = nativeArtifactDescriptors(pkg).filter(
    ({ artifactPath }) => !existsSync(artifactPath),
  );
  if (missing.length > 0) {
    throw new Error(
      `${pkg.manifest.name}: release requires every declared native artifact; missing ${missing
        .map(({ artifactPath }) => artifactPath)
        .join(", ")}`,
    );
  }
}
