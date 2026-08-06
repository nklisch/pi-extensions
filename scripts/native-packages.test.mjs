import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { listPublishPackageNames } from "./list-publish-package-names.mjs";
import {
  nativeArtifactDescriptors,
  requireNativeArtifacts,
  validateNativePackageContract,
} from "./native-packages.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-package-test-"));
  const directory = join(root, "pi-example");
  mkdirSync(join(directory, "native"), { recursive: true });
  return {
    directory,
    manifest: {
      name: "@nklisch/pi-example",
      version: "1.2.3",
      files: ["src", "native"],
      napi: {
        binaryName: "example-core",
        targets: ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"],
      },
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("native artifact distribution", () => {
  it("lists only existing workspace package names for trusted publishing", async () => {
    const names = await listPublishPackageNames();
    assert.equal(names.includes("@nklisch/pi-legible"), true);
    assert.equal(names.includes("@nklisch/pi-clearance"), true);
    assert.equal(names.some((name) => name.includes("darwin-arm64")), false);
    assert.equal(names.some((name) => name.includes("linux-x64-gnu")), false);
    assert.equal(new Set(names).size, names.length);
  });

  it("derives bundled binary names from napi targets", () => {
    const pkg = fixture();
    try {
      assert.deepEqual(
        nativeArtifactDescriptors(pkg).map(({ binaryFile }) => binaryFile),
        [
          "example-core.linux-x64-gnu.node",
          "example-core.darwin-arm64.node",
        ],
      );
    } finally {
      pkg.cleanup();
    }
  });

  it("requires the root package to include native artifacts", () => {
    const pkg = fixture();
    try {
      pkg.manifest.files = ["src"];
      pkg.manifest.optionalDependencies = {
        "@nklisch/pi-example-darwin-arm64": "1.2.3",
      };
      assert.deepEqual(validateNativePackageContract(pkg), [
        "files must include native so release-built artifacts are published",
        "native artifact must not be delegated to package @nklisch/pi-example-darwin-arm64",
      ]);
    } finally {
      pkg.cleanup();
    }
  });

  it("requires every declared artifact before release", () => {
    const pkg = fixture();
    try {
      assert.throws(
        () => requireNativeArtifacts(pkg),
        /requires every declared native artifact.*linux-x64-gnu.*darwin-arm64/,
      );

      for (const descriptor of nativeArtifactDescriptors(pkg)) {
        writeFileSync(descriptor.artifactPath, descriptor.suffix);
      }
      assert.doesNotThrow(() => requireNativeArtifacts(pkg));
    } finally {
      pkg.cleanup();
    }
  });
});
