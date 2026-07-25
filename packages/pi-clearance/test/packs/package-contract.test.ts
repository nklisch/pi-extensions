import { describe, expect, it } from "vitest";
import {
  AUTO_REVIEWER_PACK_REGISTRATION_API_VERSION,
  AUTO_REVIEWER_PACKS_REGISTER_EVENT,
  AUTO_REVIEWER_PACKS_REQUEST_EVENT,
  normalizePackagePackRegistration,
} from "../../src/packs/package-contract.ts";
import type { PolicyRule } from "../../src/policy/core.ts";

/** A valid data-pack contribution with provenance the normalizer must rewrite. */
function dataPackContribution(overrides: Record<string, unknown> = {}) {
  return {
    kind: "data-pack",
    pack: {
      version: 1,
      id: "pack:contrib",
      metadata: {
        title: "Contributed pack",
        description: "From an installed package.",
        docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
        tags: ["contrib", "read"],
        warnings: [{ level: "info", message: "operator note" }],
      },
      rules: [
        {
          id: "allow-read",
          effect: "allow",
          match: { tool: "bash" },
          reason: "contributed read rule",
          // Package-supplied provenance must be overwritten to "package".
          provenance: { source: "shipped" },
        },
      ],
    },
    ...overrides,
  };
}

function registration(
  packs: unknown[],
  provenance: Record<string, unknown> = {
    name: "demo-pkg",
    version: "1.2.3",
    installKind: "npm",
    sourceSpec: "demo-pkg@1.2.3",
    packagePath: "/node_modules/demo-pkg",
    entrypointPath: "/node_modules/demo-pkg/dist/index.js",
  },
): unknown {
  return {
    apiVersion: 1,
    package: provenance,
    packs,
  };
}

describe("package registration contract constants", () => {
  it("exports stable event names and API version", () => {
    expect(AUTO_REVIEWER_PACK_REGISTRATION_API_VERSION).toBe(1);
    expect(AUTO_REVIEWER_PACKS_REQUEST_EVENT).toBe(
      "pi-auto-approve:packs:request",
    );
    expect(AUTO_REVIEWER_PACKS_REGISTER_EVENT).toBe(
      "pi-auto-approve:packs:register",
    );
  });
});

describe("normalizePackagePackRegistration valid data packs", () => {
  it("compiles a valid data-pack and rewrites every rule provenance to package", () => {
    const result = normalizePackagePackRegistration(
      registration([dataPackContribution()]),
    );

    expect(result.issues).toEqual([]);
    expect(result.packs).toHaveLength(1);

    const normalized = result.packs[0];
    expect(normalized).toBeDefined();
    const rule = normalized?.pack.rules[0] as PolicyRule;
    expect(rule.provenance).toEqual({
      source: "package",
      packId: "pack:contrib",
      ruleId: "allow-read",
    });
    // Package-supplied "shipped" provenance must not survive.
    expect(rule.provenance.source).not.toBe("shipped");
  });

  it("rewrites rules that omitted provenance too", () => {
    const pack = {
      kind: "data-pack",
      pack: {
        version: 1,
        id: "pack:no-prov",
        rules: [
          {
            id: "r1",
            effect: "review",
            match: { tool: "bash" },
            reason: "no provenance",
          },
          {
            id: "r2",
            effect: "deny",
            match: { program: "rm" },
            reason: "second",
            provenance: { source: "user-global" },
          },
        ],
      },
    };
    const result = normalizePackagePackRegistration(registration([pack]));

    expect(result.issues).toEqual([]);
    expect(result.packs).toHaveLength(1);
    const rules = result.packs[0]?.pack.rules as readonly PolicyRule[];
    expect(rules.map((r) => r.provenance)).toEqual([
      { source: "package", packId: "pack:no-prov", ruleId: "r1" },
      { source: "package", packId: "pack:no-prov", ruleId: "r2" },
    ]);
  });

  it("preserves inert metadata and docs links verbatim", () => {
    const result = normalizePackagePackRegistration(
      registration([dataPackContribution()]),
    );

    expect(result.packs[0]?.pack.metadata).toEqual({
      title: "Contributed pack",
      description: "From an installed package.",
      docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
      tags: ["contrib", "read"],
      warnings: [{ level: "info", message: "operator note" }],
    });
  });

  it("keeps package identity on source, not on pack metadata", () => {
    const result = normalizePackagePackRegistration(
      registration([dataPackContribution()]),
    );

    const source = result.packs[0]?.source;
    expect(source).toEqual({
      kind: "package",
      packageName: "demo-pkg",
      packageVersion: "1.2.3",
      packagePath: "/node_modules/demo-pkg",
      packageInstallKind: "npm",
      packageSourceSpec: "demo-pkg@1.2.3",
      packageEntrypointPath: "/node_modules/demo-pkg/dist/index.js",
    });
    // Metadata must not carry package name/version/path.
    const metadata = result.packs[0]?.pack.metadata;
    expect(metadata).not.toHaveProperty("packageName");
    expect(metadata).not.toHaveProperty("packageVersion");
    expect(metadata).not.toHaveProperty("packagePath");
  });

  it("defaults absent installKind to unknown and omits absent optional fields", () => {
    const result = normalizePackagePackRegistration(
      registration([dataPackContribution()], { name: "bare-pkg" }),
    );

    expect(result.issues).toEqual([]);
    expect(result.packs[0]?.source).toEqual({
      kind: "package",
      packageName: "bare-pkg",
      packageInstallKind: "unknown",
    });
  });

  it("accepts every install kind", () => {
    for (const installKind of ["npm", "git", "local", "temporary", "unknown"]) {
      const result = normalizePackagePackRegistration(
        registration([dataPackContribution()], { name: "pkg", installKind }),
      );
      expect(result.issues).toEqual([]);
      expect(result.packs[0]?.source.packageInstallKind).toBe(installKind);
    }
  });

  it("normalizes multiple mixed-valid contributions independently", () => {
    const result = normalizePackagePackRegistration(
      registration([
        dataPackContribution(),
        {
          kind: "data-pack",
          pack: {
            version: 1,
            id: "pack:second",
            rules: [
              {
                id: "x",
                effect: "review",
                match: { program: "git" },
                reason: "second pack",
              },
            ],
          },
        },
      ]),
    );

    expect(result.issues).toEqual([]);
    expect(result.packs.map((p) => p.pack.id)).toEqual([
      "pack:contrib",
      "pack:second",
    ]);
  });
});

describe("normalizePackagePackRegistration invalid payloads", () => {
  it.each([
    [2, "expected apiVersion 1"],
    ["1", "expected apiVersion 1"],
    [undefined, "expected apiVersion 1"],
  ])("rejects apiVersion %s without interpreting packs", (apiVersion, msg) => {
    const payload = {
      apiVersion,
      package: { name: "demo-pkg", installKind: "npm" },
      packs: [dataPackContribution()],
    };
    const result = normalizePackagePackRegistration(payload);

    expect(result.packs).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "invalid-api-version",
        path: "$.apiVersion",
        message: msg,
      }),
    ]);
    expect(msg).toBeTruthy();
  });

  it("rejects a missing package name and attributes no packs", () => {
    const result = normalizePackagePackRegistration(
      registration([dataPackContribution()], { installKind: "npm" }),
    );

    expect(result.packs).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "missing-package-name",
        path: "$.package.name",
      }),
    ]);
  });

  it.each([
    ["non-object", "not-an-object", "$.package"],
    [
      "installKind",
      { name: "p", installKind: "frobnicate" },
      "$.package.installKind",
    ],
    ["version", { name: "p", version: 42 }, "$.package.version"],
    ["empty version", { name: "p", version: "" }, "$.package.version"],
    ["sourceSpec", { name: "p", sourceSpec: 7 }, "$.package.sourceSpec"],
    ["empty sourceSpec", { name: "p", sourceSpec: "" }, "$.package.sourceSpec"],
    ["packagePath", { name: "p", packagePath: false }, "$.package.packagePath"],
    [
      "empty packagePath",
      { name: "p", packagePath: "" },
      "$.package.packagePath",
    ],
    [
      "entrypointPath",
      { name: "p", entrypointPath: {} },
      "$.package.entrypointPath",
    ],
    [
      "empty entrypointPath",
      { name: "p", entrypointPath: "" },
      "$.package.entrypointPath",
    ],
  ])("rejects invalid package provenance: %s", (_label, prov, path) => {
    const result = normalizePackagePackRegistration(
      registration([dataPackContribution()], prov as Record<string, unknown>),
    );

    expect(result.packs).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        path,
      }),
    ]);
  });

  it("rejects an unknown contribution kind", () => {
    const result = normalizePackagePackRegistration(
      registration([{ kind: "frobnicate" }]),
    );

    expect(result.packs).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "unknown-contribution-kind",
        path: "$.packs[0].kind",
        packageName: "demo-pkg",
      }),
    ]);
  });

  it("rejects a contribution missing a kind", () => {
    const result = normalizePackagePackRegistration(
      registration([{ pack: { version: 1, id: "x", rules: [] } }]),
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "missing-contribution-kind",
        path: "$.packs[0].kind",
      }),
    ]);
  });

  it("rejects a non-object contribution", () => {
    const result = normalizePackagePackRegistration(registration(["nope"]));

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "invalid-contribution",
        path: "$.packs[0]",
        packageName: "demo-pkg",
      }),
    ]);
  });

  it("rejects an invalid data pack with a compile-error path and no thrown exception", () => {
    const badPack = {
      kind: "data-pack",
      pack: {
        version: 1,
        id: "pack:bad",
        rules: [
          {
            id: "bad-rule",
            effect: "maybe",
            match: { frobnicate: 1 },
            reason: "bad",
          },
        ],
      },
    };
    const result = normalizePackagePackRegistration(registration([badPack]));

    expect(result.packs).toEqual([]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "invalid-data-pack",
          packageName: "demo-pkg",
          packId: "pack:bad",
          ruleId: "bad-rule",
          path: "$.packs[0].pack.rules[0].effect",
        }),
        expect.objectContaining({
          severity: "error",
          code: "invalid-data-pack",
          packageName: "demo-pkg",
          packId: "pack:bad",
          ruleId: "bad-rule",
          path: "$.packs[0].pack.rules[0].match.frobnicate",
        }),
      ]),
    );
  });

  it("rejects invalid docs metadata on a data pack with an indexed path", () => {
    const result = normalizePackagePackRegistration(
      registration([
        {
          kind: "data-pack",
          pack: {
            version: 1,
            id: "pack:bad-docs",
            metadata: { docs: [{ label: "ok", href: "" }] },
            rules: [
              {
                id: "r",
                effect: "review",
                match: { tool: "bash" },
                reason: "x",
              },
            ],
          },
        },
      ]),
    );

    expect(result.packs).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "invalid-data-pack",
        path: "$.packs[0].pack.metadata.docs[0].href",
      }),
    ]);
  });

  it("accepts an absent packs array as a no-contribution package", () => {
    const payload = {
      apiVersion: 1,
      package: { name: "empty-pkg", installKind: "npm" },
    };
    const result = normalizePackagePackRegistration(payload);

    expect(result.packs).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("rejects a non-array packs field", () => {
    const result = normalizePackagePackRegistration(
      registration("not-an-array" as unknown as unknown[]),
    );

    expect(result.packs).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "invalid-packs",
        path: "$.packs",
      }),
    ]);
  });

  it("continues processing later contributions after an invalid one", () => {
    const result = normalizePackagePackRegistration(
      registration([{ kind: "frobnicate" }, dataPackContribution()]),
    );

    // The valid data pack survives while the unsupported contribution is reported.
    expect(result.packs.map((p) => p.pack.id)).toEqual(["pack:contrib"]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unknown-contribution-kind" }),
      ]),
    );
    // No invalid-data-pack issue, since the data pack was valid.
    expect(result.issues.some((i) => i.code === "invalid-data-pack")).toBe(
      false,
    );
  });
});

describe("normalizePackagePackRegistration totality", () => {
  const garbage: unknown[] = [
    null,
    undefined,
    "string",
    42,
    true,
    [],
    {},
    { apiVersion: 1, package: "nope" },
    { apiVersion: 1, package: { name: "p" }, packs: [null] },
    { apiVersion: 1, package: { name: "p" }, packs: [{ kind: "data-pack" }] },
    // Deeply nested matcher adversarial input routed through compilePack.
    {
      apiVersion: 1,
      package: { name: "p" },
      packs: [
        {
          kind: "data-pack",
          pack: {
            version: 1,
            id: "deep",
            rules: [
              {
                id: "d",
                effect: "review",
                match: deepNot(80),
                reason: "deep",
              },
            ],
          },
        },
      ],
    },
  ];

  for (const input of garbage) {
    it(`does not throw and returns a result for ${describeInput(input)}`, () => {
      expect(() => normalizePackagePackRegistration(input)).not.toThrow();
      const result = normalizePackagePackRegistration(input);
      expect(result).toBeTypeOf("object");
      expect(Array.isArray(result.packs)).toBe(true);
      expect(Array.isArray(result.issues)).toBe(true);
    });
  }

  it("does not throw on a circular registration object", () => {
    const circular: Record<string, unknown> = {
      apiVersion: 1,
      package: { name: "p", installKind: "npm" },
    };
    circular.self = circular;
    expect(() => normalizePackagePackRegistration(circular)).not.toThrow();
    const result = normalizePackagePackRegistration(circular);
    // The circular ref lives outside packs/package, so the valid shape still
    // normalizes to an empty-but-clean result.
    expect(result.packs).toEqual([]);
  });
});

function describeInput(input: unknown): string {
  if (input === null) return "null";
  if (input === undefined) return "undefined";
  if (Array.isArray(input)) return "array";
  return typeof input;
}

function deepNot(depth: number): unknown {
  let matcher: unknown = { always: true };
  for (let index = 0; index < depth; index += 1) {
    matcher = { not: matcher };
  }
  return matcher;
}
