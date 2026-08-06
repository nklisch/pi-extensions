import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { listPublishPackageNames } from "./list-publish-package-names.mjs";
import {
  nativePackageDescriptors,
  stageNativePackages,
  validateNativePackageContract,
} from "./native-packages.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-package-test-"));
  const directory = join(root, "pi-example");
  const pkg = {
    directory,
    manifest: {
      name: "@nklisch/pi-example",
      version: "1.2.3",
      description: "Example",
      license: "MIT",
      author: "Example Author",
      engines: { node: ">=24" },
      repository: { type: "git", url: "https://example.test/repo.git" },
      bugs: { url: "https://example.test/issues" },
      homepage: "https://example.test",
      files: ["src", "native/index.d.ts"],
      napi: {
        binaryName: "example-core",
        targets: ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"],
      },
      optionalDependencies: {
        "@nklisch/pi-example-linux-x64-gnu": "1.2.3",
        "@nklisch/pi-example-darwin-arm64": "1.2.3",
      },
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  mkdirSync(join(directory, "native"), { recursive: true });

  for (const descriptor of nativePackageDescriptors(pkg)) {
    mkdirSync(descriptor.directory);
    const platformManifest = {
      name: descriptor.name,
      version: descriptor.version,
      main: descriptor.binaryFile,
      files: [descriptor.binaryFile, "README.md", "LICENSE"],
      private: false,
      publishConfig: { access: "public", provenance: true },
    };
    writeFileSync(
      join(descriptor.directory, "package.json"),
      JSON.stringify(platformManifest),
    );
    writeFileSync(join(descriptor.directory, "README.md"), "native\n");
    writeFileSync(join(descriptor.directory, "LICENSE"), "MIT\n");
  }

  return pkg;
}

describe("native package distribution", () => {
  it("lists every root and derived platform package for trust setup", async () => {
    const names = await listPublishPackageNames();
    assert.equal(names.includes("@nklisch/pi-legible"), true);
    assert.equal(names.includes("@nklisch/pi-clearance-linux-x64-gnu"), true);
    assert.equal(names.includes("@nklisch/pi-clearance-darwin-arm64"), true);
    assert.equal(new Set(names).size, names.length);
  });

  it("derives scoped package identities from napi targets", () => {
    const pkg = fixture();
    try {
      assert.deepEqual(
        nativePackageDescriptors(pkg).map(({ name, binaryFile }) => ({ name, binaryFile })),
        [
          {
            name: "@nklisch/pi-example-linux-x64-gnu",
            binaryFile: "example-core.linux-x64-gnu.node",
          },
          {
            name: "@nklisch/pi-example-darwin-arm64",
            binaryFile: "example-core.darwin-arm64.node",
          },
        ],
      );
    } finally {
      pkg.cleanup();
    }
  });

  it("rejects dependency drift and root tarballs that capture host binaries", () => {
    const pkg = fixture();
    try {
      pkg.manifest.optionalDependencies["@nklisch/pi-example-darwin-arm64"] = "1.2.2";
      pkg.manifest.files = ["src", "native"];
      assert.deepEqual(validateNativePackageContract(pkg), [
        "optionalDependencies.@nklisch/pi-example-darwin-arm64 must exactly match 1.2.3",
        "files must include native/index.d.ts",
        "files must not include the native directory; platform binaries ship only in optional packages",
      ]);
    } finally {
      pkg.cleanup();
    }
  });

  it("requires every declared artifact before staging", () => {
    const pkg = fixture();
    try {
      assert.throws(
        () => stageNativePackages(pkg),
        /requires every declared target.*linux-x64-gnu.*darwin-arm64/,
      );
    } finally {
      pkg.cleanup();
    }
  });

  it("stages version-synchronized platform manifests and binaries", () => {
    const pkg = fixture();
    let staged;
    try {
      const [linux, darwin] = nativePackageDescriptors(pkg);
      writeFileSync(linux.artifactPath, "linux");
      writeFileSync(darwin.artifactPath, "darwin");

      staged = stageNativePackages(pkg);
      const manifests = staged.packages.map(({ manifest }) => manifest);
      assert.deepEqual(
        manifests.map(({ name, version }) => ({ name, version })),
        [
          { name: "@nklisch/pi-example-linux-x64-gnu", version: "1.2.3" },
          { name: "@nklisch/pi-example-darwin-arm64", version: "1.2.3" },
        ],
      );
      assert.deepEqual(manifests[0].libc, ["glibc"]);
      assert.equal(manifests[1].libc, undefined);
      assert.equal(
        readFileSync(join(staged.packages[1].directory, "example-core.darwin-arm64.node"), "utf8"),
        "darwin",
      );
      assert.equal(existsSync(join(staged.packages[0].directory, "LICENSE")), true);

      for (const nativePkg of staged.packages) {
        const report = JSON.parse(
          execFileSync("npm", ["pack", "--json", "--dry-run", "--ignore-scripts"], {
            cwd: nativePkg.directory,
            encoding: "utf8",
          }),
        );
        const files = report[0].files.map(({ path }) => path);
        assert.equal(files.includes(nativePkg.manifest.main), true);
        assert.equal(files.includes("package.json"), true);
      }
    } finally {
      staged?.cleanup();
      pkg.cleanup();
    }
  });
});
