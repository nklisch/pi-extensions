import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { realpath, readFile, lstat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative, sep, isAbsolute } from "node:path";

describe("probe debug", () => {
  it("traces resolution", async () => {
    const out: string[] = [];
    const resolvedEntry = import.meta.resolve("@nklisch/pi-mcp-adapter/programmatic");
    out.push(`resolvedEntry: ${resolvedEntry}`);
    const entry = fileURLToPath(resolvedEntry);
    out.push(`entry: ${entry}`);
    let current = dirname(entry);
    let found: string | undefined;
    for (;;) {
      try {
        const m = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
        if (m.name === "@nklisch/pi-mcp-adapter") { found = current; break; }
      } catch {}
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    out.push(`packageRoot: ${found}`);
    const root = await realpath(found!);
    const canonicalEntry = await realpath(entry);
    out.push(`root: ${root}`);
    out.push(`canonicalEntry: ${canonicalEntry}`);
    const rel = relative(root, canonicalEntry);
    out.push(`inside: ${rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))}`);
    const manifest = JSON.parse(await readFile(join(found!, "package.json"), "utf8"));
    out.push(`version: ${manifest.version} engines: ${manifest.engines?.node} peer: ${manifest.peerDependencies?.["@earendil-works/pi-coding-agent"]} ext: ${JSON.stringify(manifest.pi?.extensions)}`);
    const res = resolve(root, "./index.ts");
    out.push(`index.ts isFile: ${(await lstat(res)).isFile()}`);
    await writeFile("/tmp/probe-trace.txt", out.join("\n"));
    expect(true).toBe(true);
  });
});
