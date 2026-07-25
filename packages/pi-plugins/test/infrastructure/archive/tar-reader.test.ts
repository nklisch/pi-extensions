import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSecureContentWriterFactory } from "../../../src/infrastructure/filesystem/secure-content-writer.js";
import { createTarReader } from "../../../src/infrastructure/archive/tar-reader.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const slots: string[] = [];
const signal = (): AbortSignal => new AbortController().signal;

function octal(value: number, length: number): Uint8Array {
  return new TextEncoder().encode(value.toString(8).padStart(length - 1, "0") + "\0");
}

function tarEntry(name: string, body = "", type = "0", link = "", mode = 0o644): Uint8Array {
  const header = new Uint8Array(512);
  header.fill(0);
  header.set(new TextEncoder().encode(name).slice(0, 100), 0);
  header.set(octal(mode, 8), 100);
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
  const padding = new Uint8Array((512 - (content.byteLength % 512)) % 512);
  return new Uint8Array([...header, ...content, ...padding]);
}

function archive(...entries: Uint8Array[]): Uint8Array {
  return new Uint8Array([...entries.flatMap((entry) => [...entry]), ...new Uint8Array(1024)]);
}

function malformedSize(entry: Uint8Array): Uint8Array {
  const copy = entry.slice();
  copy.fill(0, 124, 136);
  copy.set(new TextEncoder().encode("not-octal"), 124);
  copy.fill(0x20, 148, 156);
  let checksum = 0;
  for (let index = 0; index < 512; index += 1) checksum += copy[index] ?? 0;
  copy.set(new TextEncoder().encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
  return copy;
}

async function openSink() {
  const root = await mkdtemp(join(tmpdir(), "pi-tar-test-"));
  slots.push(root);
  return { root, sink: await createSecureContentWriterFactory({ sha256 }).open({ root }) };
}

afterEach(async () => {
  await Promise.all(slots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("streaming tar policy", () => {
  it("extracts ordinary entries, defers links, and normalizes modes", async () => {
    const { root, sink } = await openSink();
    const source = archive(
      tarEntry("dir/", "", "5", "", 0o700),
      tarEntry("dir/file", "hello", "0", "", 0o755),
      tarEntry("dir/link", "", "2", "file"),
    );
    await createTarReader().read((async function* () { yield source; })(), sink, signal());
    const result = await sink.finalize(signal());
    expect((await stat(join(result.root, "dir/file"))).mode & 0o777).toBe(0o755);
    expect(result.content.entries.some((entry) => entry.kind === "symlink")).toBe(true);
    expect(await readFile(join(result.root, "dir/file"), "utf8")).toBe("hello");
    expect(root).toContain("pi-tar-test-");
  });

  it("rejects traversal, backslashes, special files, duplicate paths, and special modes", async () => {
    for (const entry of [
      tarEntry("../escape", "x"),
      tarEntry("bad\\name", "x"),
      tarEntry("device", "", "3"),
      tarEntry("setuid", "x", "0", "", 0o4755),
    ]) {
      const { sink } = await openSink();
      await expect(createTarReader().read((async function* () { yield archive(entry); })(), sink, signal())).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
      await sink.abort();
    }
    const { sink } = await openSink();
    const duplicate = archive(tarEntry("same", "a"), tarEntry("same", "b"));
    await expect(createTarReader().read((async function* () { yield duplicate; })(), sink, signal())).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
    await sink.abort();
  });

  it("preserves cancellation while the archive body is being consumed", async () => {
    const { sink } = await openSink();
    const controller = new AbortController();
    const reason = new Error("archive cancelled");
    const source = archive(tarEntry("file", "payload"));
    const input = (async function* () {
      yield source;
      controller.abort(reason);
    })();
    await expect(createTarReader().read(input, sink, controller.signal)).rejects.toBe(reason);
    await sink.abort();
  });

  it("cancels a non-cooperative archive iterator and consumes no late rejection", async () => {
    const { sink } = await openSink();
    const controller = new AbortController();
    const reason = new Error("archive cancelled while waiting for input");
    let returned = false;
    const input: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: () => {
            returned = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
    const read = createTarReader().read(input, sink, controller.signal);
    setTimeout(() => controller.abort(reason), 10);
    await expect(Promise.race([
      read,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("archive cancellation timed out")), 250)),
    ])).rejects.toBe(reason);
    expect(returned).toBe(true);
    await sink.abort();
  });

  it("rejects malformed numeric encodings", async () => {
    const { sink } = await openSink();
    await expect(createTarReader().read((async function* () {
      yield archive(malformedSize(tarEntry("bad", "x")));
    })(), sink, signal())).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
    await sink.abort();
  });

  it("counts gzip framing and metadata toward decompressed limits", async () => {
    const plain = archive(tarEntry("empty", ""));
    const { sink } = await openSink();
    await expect(createTarReader({ limits: { maxExpandedBytes: plain.byteLength - 1 } }).read(
      (async function* () { yield gzipSync(plain); })(), sink, signal(),
    )).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
    await sink.abort();

    const { sink: metadata } = await openSink();
    await expect(createTarReader().read(
      (async function* () { yield archive(tarEntry("pax", "", "x")); })(), metadata, signal(),
    )).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
    await metadata.abort();
  });

  it("materializes hardlinks after their targets and rejects cycles", async () => {
    const { sink } = await openSink();
    await createTarReader().read((async function* () {
      yield archive(tarEntry("copy", "", "1", "target"), tarEntry("target", "ok"));
    })(), sink, signal());
    const result = await sink.finalize(signal());
    expect(await readFile(join(result.root, "copy"), "utf8")).toBe("ok");

    const { sink: cycle } = await openSink();
    await createTarReader().read((async function* () {
      yield archive(tarEntry("a", "", "1", "b"), tarEntry("b", "", "1", "a"));
    })(), cycle, signal());
    await expect(cycle.finalize(signal())).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
    await cycle.abort();
  });

  it("strips one exact package prefix and supports bounded gzip input", async () => {
    const { sink } = await openSink();
    const source = gzipSync(archive(tarEntry("package/", "", "5"), tarEntry("package/index.js", "ok")));
    await createTarReader({ compression: "gzip", stripPrefix: "package" }).read((async function* () { yield source; })(), sink, signal());
    const result = await sink.finalize(signal());
    expect(await readFile(join(result.root, "index.js"), "utf8")).toBe("ok");

    const { sink: limited } = await openSink();
    await expect(createTarReader({ limits: { maxExpandedBytes: 1 } }).read((async function* () { yield archive(tarEntry("large", "xx")); })(), limited, signal())).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
    await limited.abort();
  });
});
