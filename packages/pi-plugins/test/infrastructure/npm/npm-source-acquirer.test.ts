import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNpmSourceAcquirer } from "../../../src/infrastructure/npm/npm-source-acquirer.js";
import type { NpmRegistryClient, NpmVersionRecord } from "../../../src/infrastructure/npm/npm-registry-client.js";
import { createTarReader } from "../../../src/infrastructure/archive/tar-reader.js";
import { createSecureContentWriterFactory } from "../../../src/infrastructure/filesystem/secure-content-writer.js";

const sha256 = (value: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(value).digest());
const signal = (): AbortSignal => new AbortController().signal;
const slots: string[] = [];

function octal(value: number, length: number): Uint8Array {
  return new TextEncoder().encode(value.toString(8).padStart(length - 1, "0") + "\0");
}

function entry(name: string, body = "", type = "0", link = ""): Uint8Array {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(name).slice(0, 100), 0);
  header.set(octal(0o644, 8), 100);
  header.set(octal(0, 8), 108);
  header.set(octal(0, 8), 116);
  const content = new TextEncoder().encode(body);
  header.set(octal(content.byteLength, 12), 124);
  header.set(octal(0, 12), 136);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.set(new TextEncoder().encode(link).slice(0, 100), 157);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.set(new TextEncoder().encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
  return new Uint8Array([...header, ...content, ...new Uint8Array((512 - (content.byteLength % 512)) % 512)]);
}

function archive(...entries: Uint8Array[]): Uint8Array {
  return new Uint8Array([...entries.flatMap((value) => [...value]), ...new Uint8Array(1024)]);
}

function record(tarball: Uint8Array): NpmVersionRecord {
  return {
    version: "1.0.0",
    tarball: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz",
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` as NpmVersionRecord["integrity"],
  };
}

async function sink(): Promise<Awaited<ReturnType<ReturnType<typeof createSecureContentWriterFactory>["open"]>>> {
  const root = await mkdtemp(join(tmpdir(), "pi-npm-source-test-"));
  slots.push(root);
  return createSecureContentWriterFactory({ sha256 }).open({ root });
}

function registry(tarball: Uint8Array): NpmRegistryClient {
  const selected = record(tarball);
  return {
    async resolve() {
      return { package: "fixture", registry: "https://registry.npmjs.org/", selected };
    },
    async downloadVerified(_record, destination) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(destination, tarball, { flag: "wx", mode: 0o600 });
    },
  };
}

afterEach(async () => {
  await Promise.all(slots.splice(0).map((slot) => rm(slot, { recursive: true, force: true })));
});

describe("npm source acquisition", () => {
  it("extracts only package/ bytes and never interprets lifecycle scripts", async () => {
    const tarball = gzipSync(archive(
      entry("package/", "", "5"),
      entry("package/package.json", JSON.stringify({ scripts: { preinstall: "touch marker", postinstall: "touch marker" } })),
      entry("package/index.js", "export const value = 1;"),
    ));
    const content = await sink();
    const result = await createNpmSourceAcquirer({ registry: registry(tarball), archive: createTarReader(), sha256 }).materialize(
      { kind: "npm", package: "fixture" }, content, signal(),
    );
    const finalized = await content.finalize(signal());
    expect(result.kind).toBe("npm");
    expect(await readFile(join(finalized.root, "index.js"), "utf8")).toContain("value");
    expect(await readFile(join(finalized.root, "package.json"), "utf8")).toContain("preinstall");
    await expect(readFile(join(finalized.root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an adapter result that changes an exact npm selector", async () => {
    const tarball = gzipSync(archive(entry("package/index.js", "ok")));
    const selected = record(tarball);
    const mismatched: NpmRegistryClient = {
      async resolve() {
        return {
          package: "fixture",
          registry: "https://registry.npmjs.org/",
          selected: { ...selected, version: "2.0.0" },
        };
      },
      async downloadVerified() {
        throw new Error("download must not begin");
      },
    };
    const content = await sink();
    await expect(createNpmSourceAcquirer({ registry: mismatched, archive: createTarReader(), sha256 }).materialize(
      { kind: "npm", package: "fixture", selector: "1.0.0" }, content, signal(),
    )).rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED" });
    await content.abort();
  });

  it("rejects rootless, empty, and hostile package archives before a handoff", async () => {
    for (const tarball of [
      gzipSync(archive(entry("index.js", "rootless"))),
      gzipSync(archive(entry("package/", "", "5"))),
      gzipSync(archive(entry("package/../escape", "bad"))),
    ]) {
      const content = await sink();
      await expect(createNpmSourceAcquirer({ registry: registry(tarball), archive: createTarReader(), sha256 }).materialize(
        { kind: "npm", package: "fixture" }, content, signal(),
      )).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
      await content.abort();
    }
  });
});
