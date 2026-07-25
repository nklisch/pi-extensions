import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeControlInput } from "../../../src/infrastructure/control/node-control-input.js";

const roots: string[] = [];
const base = {
  executionId: "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000",
  purpose: "uninstall" as const,
  fields: [{ key: "answer", label: { text: "Answer", escaped: false, truncated: false }, kind: "string" as const, required: true, sensitive: false, defaultPresent: false, constraints: {}, state: "missing" as const }],
  expected: { plugin: "demo@market", scope: { kind: "user" as const } },
};
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("node native control input", () => {
  it("reads one bounded stdin JSON document and never prompts", async () => {
    const document = JSON.stringify({ expected: base.expected, values: { answer: "yes" }, decision: { kind: "confirm" } });
    const port = createNodeControlInput({ stdin: Readable.from([document]) });
    const request = { ...base, channel: { kind: "stdin-json" as const } };
    await expect(port.collect(request as never, new AbortController().signal)).resolves.toMatchObject({ kind: "supplied", nonSensitive: [{ key: "answer", value: "yes" }] });
    await expect(port.collect(request as never, new AbortController().signal)).resolves.toEqual({ kind: "unavailable", code: "CHANNEL_UNSUPPORTED" });
  });

  it("aborts an idle read without destroying shared stdin or retaining listeners", async () => {
    const stdin = new PassThrough();
    stdin.pause();
    const request = { ...base, channel: { kind: "stdin-json" as const } };
    const controller = new AbortController();
    const pending = createNodeControlInput({ stdin }).collect(request as never, controller.signal);
    controller.abort(new DOMException("interrupted", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stdin.destroyed).toBe(false);
    expect(stdin.isPaused()).toBe(true);
    for (const event of ["data", "end", "error", "close"] as const) expect(stdin.listenerCount(event)).toBe(0);

    const document = JSON.stringify({ expected: base.expected, values: { answer: "yes" }, decision: { kind: "confirm" } });
    const reused = createNodeControlInput({ stdin }).collect(request as never, new AbortController().signal);
    stdin.end(document);
    await expect(reused).resolves.toMatchObject({ kind: "supplied" });
  });

  it("requires an owner-only regular no-follow file", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-control-input-")); roots.push(root);
    const file = join(root, "input.json");
    await writeFile(file, JSON.stringify({ expected: base.expected, values: { answer: "yes" }, decision: { kind: "confirm" } }), { mode: 0o600 });
    const port = createNodeControlInput();
    await expect(port.collect({ ...base, channel: { kind: "file-json", locator: file } } as never, new AbortController().signal)).resolves.toMatchObject({ kind: "supplied" });
    await chmod(file, 0o644);
    await expect(port.collect({ ...base, channel: { kind: "file-json", locator: file } } as never, new AbortController().signal)).resolves.toMatchObject({ kind: "invalid" });
  });

  it("rejects secrets and consent from environment channels", async () => {
    const port = createNodeControlInput({ environment: { SAFE_ANSWER: "yes" } });
    await expect(port.collect({ ...base, fields: [{ ...base.fields[0], sensitive: true }], channel: { kind: "environment", prefix: "SAFE_" } } as never, new AbortController().signal)).resolves.toEqual({ kind: "unavailable", code: "SECRET_PROMPT_UNAVAILABLE" });
    await expect(port.collect({ ...base, channel: { kind: "environment", prefix: "SAFE_" } } as never, new AbortController().signal)).resolves.toMatchObject({ kind: "supplied", nonSensitive: [{ value: "yes" }] });
  });
});
