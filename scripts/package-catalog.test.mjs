import assert from "node:assert/strict";
import test from "node:test";
import { orderPackagesForPublish } from "./package-catalog.mjs";

function pkg(name, dependencies = {}, optionalDependencies = {}) {
  return { manifest: { name, dependencies, optionalDependencies } };
}

test("orderPackagesForPublish publishes local dependencies before dependents", () => {
  const enhanced = pkg("@nklisch/pi-enhanced", {
    "@nklisch/pi-mcp-adapter": "2.20.1-nklisch.1",
    "@nklisch/pi-plugins": "^0",
  });
  const mcp = pkg("@nklisch/pi-mcp-adapter");
  const plugins = pkg("@nklisch/pi-plugins", {
    "@nklisch/pi-mcp-adapter": "2.20.1-nklisch.1",
    "@nklisch/pi-subagents": "18.1.0-nklisch.1",
  });
  const subagents = pkg("@nklisch/pi-subagents");

  assert.deepEqual(
    orderPackagesForPublish([enhanced, mcp, plugins, subagents]).map(entry => entry.manifest.name),
    [
      "@nklisch/pi-mcp-adapter",
      "@nklisch/pi-subagents",
      "@nklisch/pi-plugins",
      "@nklisch/pi-enhanced",
    ],
  );
});

test("orderPackagesForPublish includes optional local dependencies in publication order", () => {
  const root = pkg("@nklisch/root", {}, { "@nklisch/native": "1.0.0" });
  const native = pkg("@nklisch/native");
  assert.deepEqual(
    orderPackagesForPublish([root, native]).map(entry => entry.manifest.name),
    ["@nklisch/native", "@nklisch/root"],
  );
});

test("orderPackagesForPublish rejects local dependency cycles", () => {
  const a = pkg("a", { b: "1" });
  const b = pkg("b", { a: "1" });
  assert.throws(
    () => orderPackagesForPublish([a, b]),
    /Local package dependency cycle prevents safe publication: a -> b -> a/u,
  );
});
