import { describe, expect, expectTypeOf, it } from "vitest";
import * as piApi from "../src/pi/index.js";
import type {
  PackagedPluginHost,
  PackagedPluginHostApplication,
  PackagedPluginHostOptions,
  StartedPackagedPluginHost,
} from "../src/pi/index.js";

describe("Pi package public API", () => {
  it("exports only the construct-only host boundary at runtime", () => {
    expect(Object.keys(piApi).sort()).toEqual([
      "PackagedPluginHostError",
      "PackagedPluginHostErrorCode",
      "createPackagedPluginHost",
    ]);
    expect(piApi).not.toHaveProperty("createPiSessionBinding");
    expect(piApi).not.toHaveProperty("createPiReloadBroker");
    expect(piApi).not.toHaveProperty("createRuntimeSelectionCatalog");
  });

  it("exposes safe structural host and application types", () => {
    expectTypeOf<PackagedPluginHostOptions>().toBeObject();
    expectTypeOf<PackagedPluginHost>().toBeObject();
    expectTypeOf<StartedPackagedPluginHost>().toBeObject();
    expectTypeOf<PackagedPluginHostApplication>().toBeObject();
  });
});
