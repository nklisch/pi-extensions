import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const TARGETS = new Map([
  [
    "x86_64-unknown-linux-gnu",
    {
      suffix: "linux-x64-gnu",
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
    },
  ],
  [
    "aarch64-apple-darwin",
    {
      suffix: "darwin-arm64",
      os: ["darwin"],
      cpu: ["arm64"],
    },
  ],
]);

export function isNativePlatformPackage(manifest) {
  return typeof manifest.main === "string" && manifest.main.endsWith(".node");
}

/**
 * Derive platform workspace identities from one napi-rs root manifest.
 *
 * Keeping this derivation centralized prevents the root dependency names,
 * loader names, platform manifests, and publisher order from drifting.
 */
export function nativePackageDescriptors(pkg) {
  const napi = pkg.manifest.napi;
  if (napi === undefined) return [];
  if (typeof napi.binaryName !== "string" || !Array.isArray(napi.targets)) {
    throw new Error(`${pkg.manifest.name}: napi.binaryName and napi.targets are required`);
  }

  return napi.targets.map((target) => {
    const platform = TARGETS.get(target);
    if (platform === undefined) {
      throw new Error(`${pkg.manifest.name}: unsupported napi target ${target}`);
    }
    const binaryFile = `${napi.binaryName}.${platform.suffix}.node`;
    const directory = join(dirname(pkg.directory), `${basename(pkg.directory)}-${platform.suffix}`);
    return {
      ...platform,
      target,
      suffix: platform.suffix,
      name: `${pkg.manifest.name}-${platform.suffix}`,
      version: pkg.manifest.version,
      binaryFile,
      artifactPath: join(pkg.directory, "native", binaryFile),
      directory,
      manifestPath: join(directory, "package.json"),
    };
  });
}

/** Validate source-controlled contracts without requiring cross-built artifacts. */
export function validateNativePackageContract(pkg) {
  const descriptors = nativePackageDescriptors(pkg);
  if (descriptors.length === 0) return [];

  const errors = [];
  const optional = pkg.manifest.optionalDependencies ?? {};
  const expectedNames = new Set(descriptors.map(({ name }) => name));

  for (const descriptor of descriptors) {
    if (optional[descriptor.name] !== pkg.manifest.version) {
      errors.push(
        `optionalDependencies.${descriptor.name} must exactly match ${pkg.manifest.version}`,
      );
    }
    if (!existsSync(descriptor.manifestPath)) {
      errors.push(`native platform workspace is missing: ${descriptor.manifestPath}`);
      continue;
    }
    const platformManifest = JSON.parse(readFileSync(descriptor.manifestPath, "utf8"));
    for (const error of validatePlatformManifest(descriptor, platformManifest)) {
      errors.push(`${descriptor.name}: ${error}`);
    }
  }
  for (const name of Object.keys(optional)) {
    if (name.startsWith(`${pkg.manifest.name}-`) && !expectedNames.has(name)) {
      errors.push(`unexpected native optional dependency ${name}`);
    }
  }

  const files = pkg.manifest.files ?? [];
  if (!files.includes("native/index.d.ts")) {
    errors.push("files must include native/index.d.ts");
  }
  if (files.includes("native") || files.includes("native/")) {
    errors.push(
      "files must not include the native directory; platform binaries ship only in optional packages",
    );
  }

  return errors;
}

/**
 * Stage publish-ready platform packages in a temporary directory.
 * All declared targets are required together so a release cannot be only
 * accidentally portable on the publisher's host operating system.
 */
export function stageNativePackages(pkg) {
  const errors = validateNativePackageContract(pkg);
  if (errors.length > 0) {
    throw new Error(`${pkg.manifest.name}: invalid native package contract: ${errors.join("; ")}`);
  }

  const descriptors = nativePackageDescriptors(pkg);
  const missing = descriptors.filter(({ artifactPath }) => !existsSync(artifactPath));
  if (missing.length > 0) {
    throw new Error(
      `${pkg.manifest.name}: native publish preparation requires every declared target; missing ${missing
        .map(({ artifactPath }) => artifactPath)
        .join(", ")}`,
    );
  }

  const root = mkdtempSync(join(tmpdir(), "pi-native-packages-"));
  const packages = descriptors.map((descriptor) => {
    const directory = join(root, descriptor.suffix);
    mkdirSync(directory, { recursive: true });
    const sourceManifest = JSON.parse(readFileSync(descriptor.manifestPath, "utf8"));
    // Workspace templates omit os/cpu/libc so `npm ci` can link every target on
    // every development host. Only the release-staged manifest receives the
    // restrictive selectors consumed by npm clients.
    const manifest = {
      ...sourceManifest,
      os: descriptor.os,
      cpu: descriptor.cpu,
    };
    if (descriptor.libc !== undefined) manifest.libc = descriptor.libc;
    else delete manifest.libc;
    writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const file of ["README.md", "LICENSE"]) {
      copyFileSync(join(descriptor.directory, file), join(directory, file));
    }
    copyFileSync(descriptor.artifactPath, join(directory, descriptor.binaryFile));

    return {
      directory,
      directoryName: basename(descriptor.directory),
      manifest,
      manifestPath: join(directory, "package.json"),
    };
  });

  return {
    packages,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function validatePlatformManifest(descriptor, manifest) {
  const errors = [];
  const checks = [
    [manifest.name, descriptor.name, "name"],
    [manifest.version, descriptor.version, "version"],
    [manifest.main, descriptor.binaryFile, "main"],
    [manifest.private, false, "private"],
    [manifest.publishConfig?.access, "public", "publishConfig.access"],
    [manifest.publishConfig?.provenance, true, "publishConfig.provenance"],
  ];
  for (const [actual, expected, label] of checks) {
    if (actual !== expected) errors.push(`${label} must be ${JSON.stringify(expected)}`);
  }
  if (manifest.os !== undefined || manifest.cpu !== undefined || manifest.libc !== undefined) {
    errors.push("workspace template must omit os/cpu/libc; release staging derives them from napi.targets");
  }
  if (!manifest.files?.includes(descriptor.binaryFile)) {
    errors.push(`files must include ${descriptor.binaryFile}`);
  }
  return errors;
}
