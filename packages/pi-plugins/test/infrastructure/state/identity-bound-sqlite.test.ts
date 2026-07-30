import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openIdentityBoundSqliteDatabase } from "../../../src/infrastructure/state/identity-bound-sqlite.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "identity-bound-sqlite-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  const signal = new AbortController().signal;
  const open = () =>
    openIdentityBoundSqliteDatabase({
      root,
      path,
      signal,
      initialize(database) {
        database.exec("CREATE TABLE probe(value TEXT NOT NULL) STRICT; INSERT INTO probe VALUES ('ready');");
      },
      validate(database) {
        const row = database.prepare("SELECT value FROM probe").get() as { value: string } | undefined;
        if (row?.value !== "ready") throw new Error("probe schema is invalid");
      },
    });
  const markerPath = `${path}.identity`;
  const rewriteMarker = async (mutate: (marker: { device: string; inode: string }) => void) => {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { identity: { device: string; inode: string } };
    mutate(marker.identity);
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
  };
  return { open, rewriteMarker };
}

describe("identity-bound SQLite", () => {
  it("accepts device drift with an unchanged inode (remount/reboot on btrfs)", async () => {
    const { open, rewriteMarker } = await fixture();
    const first = await open();
    first.close();
    // Simulate a previous mount epoch: btrfs assigns anonymous st_dev per
    // mount, so a reboot changes device while the file is genuinely unchanged.
    await rewriteMarker((identity) => {
      identity.device = "previous-mount-epoch";
    });
    const second = await open();
    second.close();
  });

  it("rejects an inode mismatch even when the device matches", async () => {
    const { open, rewriteMarker } = await fixture();
    const first = await open();
    first.close();
    await rewriteMarker((identity) => {
      identity.inode = "99999999999";
    });
    await expect(open()).rejects.toThrow("SQLite database identity marker does not match its path");
  });
});
