import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// dependency-cruiser may be hoisted to the monorepo root, so resolve its bin
// through the module graph instead of assuming a package-local node_modules.
// Its exports map is import-only and hides ./package.json, so resolve the
// main entry via ESM resolution and walk up to the package root.
const DEPCRUISE_BIN = (() => {
  let dir = dirname(fileURLToPath(import.meta.resolve("dependency-cruiser")));
  while (!existsSync(resolve(dir, "package.json"))) dir = dirname(dir);
  return resolve(dir, "bin/dependency-cruise.mjs");
})();

function cruise(root: string, fixture: string): string {
  const result = spawnSync(
    process.execPath,
    [DEPCRUISE_BIN, fixture, "--config", ".dependency-cruiser.cjs"],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status).not.toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

describe("dependency boundary regression", () => {
  it("keeps the committed rule able to reject domain-to-Node and domain-to-outer-layer imports", () => {
    const root = process.cwd();
    const fixture = resolve(root, "src/domain/.boundary-regression-fixture.ts");
    const applicationDirectory = resolve(root, "src/application");
    const outerLayer = resolve(applicationDirectory, ".boundary-regression-target.ts");
    const hadApplicationDirectory = existsSync(applicationDirectory);
    mkdirSync(applicationDirectory, { recursive: true });
    writeFileSync(outerLayer, "export const boundaryRegressionTarget = true;\n", "utf8");
    writeFileSync(fixture, [
      'import { readFile } from "node:fs/promises";',
      'import { boundaryRegressionTarget } from "../application/.boundary-regression-target.js";',
      "void readFile;",
      "void boundaryRegressionTarget;",
    ].join("\n"), "utf8");

    try {
      const output = cruise(root, "src/domain/.boundary-regression-fixture.ts");
      expect(output).toContain("domain-no-node-builtins");
      expect(output).toContain("domain-no-outer-layer-imports");
    } finally {
      rmSync(fixture, { force: true });
      rmSync(outerLayer, { force: true });
      if (!hadApplicationDirectory) rmSync(applicationDirectory, { recursive: true, force: true });
    }
  });

  it("rejects format Node and outer-layer imports", () => {
    const root = process.cwd();
    const formatFixture = resolve(root, "src/formats/.boundary-regression-fixture.ts");
    const applicationDirectory = resolve(root, "src/application");
    const applicationTarget = resolve(applicationDirectory, ".format-boundary-regression-target.ts");
    mkdirSync(applicationDirectory, { recursive: true });
    writeFileSync(applicationTarget, "export const formatBoundaryRegressionTarget = true;\n", "utf8");
    writeFileSync(formatFixture, [
      'import { readFile } from "node:fs/promises";',
      'import { formatBoundaryRegressionTarget } from "../application/.format-boundary-regression-target.js";',
      "void readFile;",
      "void formatBoundaryRegressionTarget;",
    ].join("\n"), "utf8");
    try {
      const output = cruise(root, "src/formats/.boundary-regression-fixture.ts");
      expect(output).toContain("formats-no-outer-or-node-imports");
    } finally {
      rmSync(formatFixture, { force: true });
      rmSync(applicationTarget, { force: true });
    }
  });

  it("rejects state schema and state-port imports with the dedicated rules", () => {
    const root = process.cwd();
    const stateDirectory = resolve(root, "src/domain/state");
    const stateFixture = resolve(stateDirectory, ".state-boundary-regression-fixture.ts");
    const stateTarget = resolve(root, "src/application/.state-boundary-regression-target.ts");
    const portDirectory = resolve(root, "src/application/ports");
    const portFixture = resolve(portDirectory, ".state-port-boundary-regression-fixture.ts");
    const portTarget = resolve(root, "src/infrastructure/.state-port-boundary-regression-target.ts");
    mkdirSync(resolve(root, "src/infrastructure"), { recursive: true });
    writeFileSync(stateTarget, "export const stateBoundaryTarget = true;\n", "utf8");
    writeFileSync(portTarget, "export const statePortBoundaryTarget = true;\n", "utf8");
    writeFileSync(stateFixture, [
      'import { readFile } from "node:fs/promises";',
      'import { stateBoundaryTarget } from "../../application/.state-boundary-regression-target.js";',
      "void readFile;",
      "void stateBoundaryTarget;",
    ].join("\n"), "utf8");
    writeFileSync(portFixture, [
      'import { readFile } from "node:fs/promises";',
      'import { statePortBoundaryTarget } from "../../infrastructure/.state-port-boundary-regression-target.js";',
      "void readFile;",
      "void statePortBoundaryTarget;",
    ].join("\n"), "utf8");
    try {
      const stateOutput = cruise(root, "src/domain/state/.state-boundary-regression-fixture.ts");
      expect(stateOutput).toContain("state-domain-no-node-builtins");
      expect(stateOutput).toContain("state-domain-no-outer-layer-imports");
      const portOutput = cruise(root, "src/application/ports/.state-port-boundary-regression-fixture.ts");
      expect(portOutput).toContain("state-port-no-node-builtins");
      expect(portOutput).toContain("state-port-no-outer-layer-imports");
      expect(portOutput).toContain("application-ports-no-backend-technology");
    } finally {
      rmSync(stateFixture, { force: true });
      rmSync(stateTarget, { force: true });
      rmSync(portFixture, { force: true });
      rmSync(portTarget, { force: true });
    }
  });

  it("keeps the MCP lifecycle participant out of transaction and host authority", () => {
    const root = process.cwd();
    const fixture = resolve(root, "src/runtime/mcp/.boundary-regression-fixture.ts");
    writeFileSync(fixture, [
      'import { createLifecycleRecoveryService } from "../../application/recovery-service.js";',
      "void createLifecycleRecoveryService;",
    ].join("\n"), "utf8");
    try {
      const output = cruise(root, "src/runtime/mcp/.boundary-regression-fixture.ts");
      expect(output).toContain("mcp-lifecycle-participant-no-transaction-or-host-authority");
    } finally {
      rmSync(fixture, { force: true });
    }
  });

  it("rejects application runtime/adapter imports and infrastructure-to-format imports", () => {
    const root = process.cwd();
    const applicationFixture = resolve(root, "src/application/.boundary-regression-fixture.ts");
    const infrastructureDirectory = resolve(root, "src/infrastructure");
    const infrastructureFixture = resolve(infrastructureDirectory, ".boundary-regression-fixture.ts");
    mkdirSync(infrastructureDirectory, { recursive: true });
    writeFileSync(applicationFixture, [
      'import { DatabaseSync } from "node:sqlite";',
      'import { readFile } from "node:fs/promises";',
      'import { boundaryRegressionTarget } from "../infrastructure/.boundary-regression-target.js";',
      "void DatabaseSync;",
      "void readFile;",
      "void boundaryRegressionTarget;",
    ].join("\n"), "utf8");
    writeFileSync(resolve(infrastructureDirectory, ".boundary-regression-target.ts"), "export const boundaryRegressionTarget = true;\n", "utf8");
    writeFileSync(infrastructureFixture, 'import { MarketplaceSourceSchema } from "../formats/marketplace-reader-support.js";\nvoid MarketplaceSourceSchema;\n', "utf8");
    try {
      const appOutput = cruise(root, "src/application/.boundary-regression-fixture.ts");
      expect(appOutput).toContain("application-no-node-builtins");
      expect(appOutput).toContain("application-no-outer-layer-imports");
      expect(appOutput).toContain("sqlite-only-state-infrastructure");
      const infraOutput = cruise(root, "src/infrastructure/.boundary-regression-fixture.ts");
      expect(infraOutput).toContain("infrastructure-no-outer-layer-imports");
    } finally {
      rmSync(applicationFixture, { force: true });
      rmSync(infrastructureFixture, { force: true });
      rmSync(resolve(infrastructureDirectory, ".boundary-regression-target.ts"), { force: true });
    }
  });
});
