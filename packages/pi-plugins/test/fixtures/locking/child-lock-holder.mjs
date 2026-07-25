import { DatabaseSync } from "node:sqlite";

const [path] = process.argv.slice(2);
if (typeof path !== "string") throw new Error("lock path required");
const database = new DatabaseSync(path, {
  allowExtension: false,
  defensive: true,
  enableDoubleQuotedStringLiterals: false,
  enableForeignKeyConstraints: true,
  timeout: 0,
});
database.enableLoadExtension(false);
database.enableDefensive(true);
database.exec("PRAGMA journal_mode = DELETE; PRAGMA locking_mode = NORMAL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
database.exec("CREATE TABLE IF NOT EXISTS scope_lock_protocol (protocol TEXT PRIMARY KEY NOT NULL CHECK (protocol = 'pi-plugin-host-scope-lock'), version INTEGER NOT NULL CHECK (version = 1)) STRICT;");
database.exec("INSERT OR IGNORE INTO scope_lock_protocol (protocol, version) VALUES ('pi-plugin-host-scope-lock', 1);");
database.exec("BEGIN IMMEDIATE");
const ready = { kind: "ready" };
process.stdout.write(`${JSON.stringify(ready)}\n`);
const release = () => {
  database.exec("ROLLBACK");
  database.close();
  process.exit(0);
};
process.on("message", (message) => {
  if (message === "release") release();
});
process.stdin.on("data", (chunk) => {
  if (chunk.toString().includes("release")) release();
});
process.on("SIGTERM", () => {
  database.close();
  process.exit(0);
});
