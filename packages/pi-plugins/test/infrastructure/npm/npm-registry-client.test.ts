import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNpmRegistryClient, type NpmRegistryClient } from "../../../src/infrastructure/npm/npm-registry-client.js";
import type { BoundedFetch, BoundedFetchResponse, NpmCredentialProvider } from "../../../src/infrastructure/http/bounded-fetch.js";
import { DEFAULT_MATERIALIZATION_LIMITS } from "../../../src/application/ports/source-acquisition.js";

const signal = (): AbortSignal => new AbortController().signal;
const roots: string[] = [];

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function stream(value: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () { yield value; })();
}

function fakeFetch(routes: Readonly<Record<string, Readonly<{ status: number; body: Uint8Array }>>>): BoundedFetch {
  return {
    async request(request): Promise<BoundedFetchResponse> {
      const route = routes[request.url];
      if (route === undefined) throw new Error(`unexpected URL ${request.url}`);
      return { status: route.status, headers: new Headers(), url: request.url, body: stream(route.body) };
    },
  };
}

function integrity(body: Uint8Array): string {
  return `sha512-${createHash("sha512").update(body).digest("base64")}`;
}

function packument(records: Readonly<Record<string, Readonly<{ tarball: string; integrity?: string }>>>, tags: Readonly<Record<string, string>> = { latest: "1.0.0" }): Uint8Array {
  return bytes(JSON.stringify({
    "dist-tags": tags,
    versions: Object.fromEntries(Object.entries(records).map(([version, dist]) => [version, {
      version,
      dist,
    }])),
    _id: "fixture",
    time: { created: "not used" },
  }));
}

function client(packumentBytes: Uint8Array, tarballs: Readonly<Record<string, Uint8Array>> = {}): NpmRegistryClient {
  const routes: Record<string, { status: number; body: Uint8Array }> = {
    "https://registry.npmjs.org/fixture": { status: 200, body: packumentBytes },
  };
  for (const [url, body] of Object.entries(tarballs)) routes[url] = { status: 200, body };
  return createNpmRegistryClient({
    fetch: fakeFetch(routes),
    credentials: { apply() {} },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("npm registry client", () => {
  it("resolves latest, exact versions, tags, ranges, and explicit prereleases", async () => {
    const records = {
      "1.0.0": { tarball: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz", integrity: integrity(bytes("one")) },
      "1.2.0": { tarball: "https://registry.npmjs.org/fixture/-/fixture-1.2.0.tgz", integrity: integrity(bytes("two")) },
      "2.0.0-beta.1": { tarball: "https://registry.npmjs.org/fixture/-/fixture-2.0.0-beta.1.tgz", integrity: integrity(bytes("beta")) },
    } as const;
    const packageBytes = packument(records, { latest: "1.2.0", beta: "2.0.0-beta.1" });
    const tarballs = Object.fromEntries(Object.entries(records).map(([version, record]) => [record.tarball, bytes(version)]));
    const registry = client(packageBytes, tarballs);

    expect((await registry.resolve({ kind: "npm", package: "fixture" }, signal())).selected.version).toBe("1.2.0");
    expect((await registry.resolve({ kind: "npm", package: "fixture", selector: "1.0.0" }, signal())).selected.version).toBe("1.0.0");
    expect((await registry.resolve({ kind: "npm", package: "fixture", selector: "beta" }, signal())).selected.version).toBe("2.0.0-beta.1");
    expect((await registry.resolve({ kind: "npm", package: "fixture", selector: ">=1 <2" }, signal())).selected.version).toBe("1.2.0");
    expect((await registry.resolve({ kind: "npm", package: "fixture", selector: ">=2.0.0-beta.1 <3" }, signal())).selected.version).toBe("2.0.0-beta.1");
  });

  it("rejects malformed metadata, unknown selectors, prerelease-only ranges, and bad package names", async () => {
    const good = { tarball: "https://registry.npmjs.org/fixture/-/fixture.tgz", integrity: integrity(bytes("ok")) };
    const registry = client(packument({ "1.0.0": good }, { latest: "1.0.0" }));
    await expect(registry.resolve({ kind: "npm", package: "fixture", selector: "missing" }, signal())).rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED", classification: "permanent" });
    await expect(registry.resolve({ kind: "npm", package: "../escape" }, signal())).rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED" });

    const malformed = client(bytes("{"));
    await expect(malformed.resolve({ kind: "npm", package: "fixture" }, signal())).rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED" });

    const missingIntegrity = client(packument({ "1.0.0": { tarball: good.tarball } }));
    await expect(missingIntegrity.resolve({ kind: "npm", package: "fixture" }, signal())).rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED" });
  });

  it("bounds packuments and removes a mismatched tarball before extraction could begin", async () => {
    const packageBytes = bytes(JSON.stringify({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { version: "1.0.0", dist: { tarball: "https://registry.npmjs.org/fixture/-/fixture.tgz", integrity: integrity(bytes("expected")) } } } }));
    const registry = client(packageBytes, { "https://registry.npmjs.org/fixture/-/fixture.tgz": bytes("tampered") });
    const root = await mkdtemp(join(tmpdir(), "pi-npm-registry-test-"));
    roots.push(root);
    const destination = join(root, ".work", "package.tgz");
    const resolved = await registry.resolve({ kind: "npm", package: "fixture" }, signal());
    await expect(registry.downloadVerified(resolved.selected, destination, DEFAULT_MATERIALIZATION_LIMITS, signal())).rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED", classification: "permanent" });
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    const oversized = client(bytes("x".repeat(DEFAULT_MATERIALIZATION_LIMITS.maxPackumentBytes + 1)));
    await expect(oversized.resolve({ kind: "npm", package: "fixture" }, signal())).rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED", classification: "permanent" });
    await expect(readFile(destination)).rejects.toBeDefined();
  });

  it("does not place credential values in failures", async () => {
    const secret = "npm-fixture-secret";
    const registry = createNpmRegistryClient({
      fetch: {
        async request() {
          throw new Error(`server rejected Authorization: Bearer ${secret}`);
        },
      },
      credentials: { apply(_url: URL, headers: Headers, _signal: AbortSignal) { headers.set("authorization", `Bearer ${secret}`); } } satisfies NpmCredentialProvider,
    });
    const error = await registry.resolve({ kind: "npm", package: "fixture" }, signal()).catch((value: unknown) => value);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
