import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPluginInspectionService } from "../../src/application/inspection-service.js";
import { createNodePluginInspector } from "../../src/composition/create-plugin-inspector.js";
import type { BundleReaderSet } from "../../src/application/ports/bundle-readers.js";
import { createContentManifest, createMaterializationBinding, hashContent, type ContentManifestEntry } from "../../src/domain/content-manifest.js";
import { readClaudeHooks } from "../../src/formats/claude/hook-reader.js";
import { readClaudePluginManifest } from "../../src/formats/claude/manifest-reader.js";
import { readClaudeMcp } from "../../src/formats/claude/mcp-reader.js";
import { readCodexHooks } from "../../src/formats/codex/hook-reader.js";
import { readCodexPluginManifest } from "../../src/formats/codex/manifest-reader.js";
import { readCodexMcp } from "../../src/formats/codex/mcp-reader.js";
import { readAgentSkill } from "../../src/formats/agent-skills/skill-reader.js";
import { readBoundedYaml } from "../../src/formats/agent-skills/frontmatter-reader.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";
import { readCodexMarketplace } from "../../src/formats/codex/marketplace-reader.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import type {
  BundleDocumentLimitsContract,
  BundleInspectionInput,
} from "../../src/application/inspection-contract.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(
  new URL(`../fixtures/plugins/adversarial-skills/${name}`, import.meta.url),
));

function file(path: string, bytes: Uint8Array): ContentManifestEntry {
  return { kind: "file", path, mode: 0o644, size: bytes.byteLength, digest: hashContent(bytes, sha256) };
}

function entryForClaude(fields: Record<string, unknown> = {}) {
  const result = readClaudeMarketplace({
    name: "catalog",
    plugins: [{ name: "demo", source: "./plugin", strict: false, ...fields }],
  });
  const entry = result.marketplace.entries[0];
  if (entry === undefined) throw new Error("missing test entry");
  return entry;
}

function entryForCodex(fields: Record<string, unknown> = {}) {
  const result = readCodexMarketplace({
    name: "catalog",
    plugins: [{ name: "demo", source: "./plugin", policy: { installation: "AVAILABLE" }, ...fields }],
  });
  const entry = result.marketplace.entries[0];
  if (entry === undefined) throw new Error("missing test entry");
  return entry;
}

function makeInput(
  files: ReadonlyMap<string, Uint8Array>,
  entry: BundleInspectionInput["entry"],
  extraEntries: readonly ContentManifestEntry[] = [],
  resolvedSource?: BundleInspectionInput["materialized"]["source"],
): BundleInspectionInput {
  const paths = new Set<string>();
  for (const path of files.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) paths.add(segments.slice(0, index).join("/"));
  }
  const entries: ContentManifestEntry[] = [
    ...[...paths].map((path): ContentManifestEntry => ({ kind: "directory", path, mode: 0o755 })),
    ...[...files.entries()].map(([path, bytes]) => file(path, bytes)),
    ...extraEntries,
  ];
  const content = createContentManifest(entries, sha256);
  const source = resolvedSource ?? (() => {
    const declared = entry.source.value;
    if (declared.kind !== "marketplace-path") throw new Error("test entry is not a marketplace path");
    return createResolvedPluginSource({
      kind: "marketplace-path",
      marketplaceRevision: "a".repeat(40),
      path: declared.path,
    }, sha256);
  })();
  return {
    entry,
    materialized: {
      root: "/virtual/plugin",
      source,
      content,
      binding: createMaterializationBinding(source.hash, content.rootDigest, sha256),
    },
  };
}

function readers(): BundleReaderSet {
  return {
    claudeManifest: readClaudePluginManifest,
    codexManifest: readCodexPluginManifest,
    claudeHooks: readClaudeHooks,
    codexHooks: readCodexHooks,
    claudeMcp: readClaudeMcp,
    codexMcp: readCodexMcp,
    agentSkill: (markdown, context) => readAgentSkill(markdown, context, sha256, context.limits),
    skillPresentation: readBoundedYaml,
  };
}

function service(
  files: ReadonlyMap<string, Uint8Array>,
  reads: Array<{ path: string; limit: number }> = [],
  limits?: Partial<BundleDocumentLimitsContract>,
) {
  return createPluginInspectionService({
    content: {
      async readFile(file, limit) {
        reads.push({ path: file.entry.path, limit });
        const bytes = files.get(file.entry.path);
        if (bytes === undefined) throw new Error(`missing ${file.entry.path}`);
        return bytes;
      },
    },
    readers: readers(),
    sha256,
    ...(limits === undefined ? {} : { limits }),
  });
}

const GIT_URL = "https://example.test/plugin.git";
const PIN = "a".repeat(40);
const OTHER_PIN = "b".repeat(40);
const NAMED_REF_REVISION = "c".repeat(40);

type GitSourceKind = "git" | "git-subdir";

function entryForGit(kind: GitSourceKind, selectors: Readonly<{ ref?: string; sha?: string }> = {}) {
  const source = kind === "git"
    ? { source: "url", url: GIT_URL, ...selectors }
    : { source: "git-subdir", url: GIT_URL, path: "plugins/demo", ...selectors };
  const result = readClaudeMarketplace({
    name: "catalog",
    plugins: [{ name: "demo", strict: false, source }],
  });
  const entry = result.marketplace.entries[0];
  if (entry === undefined) throw new Error("missing Git test entry");
  return entry;
}

function inputForGit(
  files: ReadonlyMap<string, Uint8Array>,
  entry: BundleInspectionInput["entry"],
  revision: string,
): BundleInspectionInput {
  const declared = entry.source.value;
  const source = declared.kind === "git"
    ? createResolvedPluginSource({ kind: "git", url: declared.url, revision }, sha256)
    : declared.kind === "git-subdir"
      ? createResolvedPluginSource({ kind: "git-subdir", url: declared.url, path: declared.path, revision }, sha256)
      : (() => { throw new Error("expected a Git source"); })();
  return makeInput(files, entry, [], source);
}

describe("plugin inspection service review-hardening matrix", () => {
  it("uses authoritative Git selector precedence for git and git-subdir handoffs", async () => {
    for (const kind of ["git", "git-subdir"] as const) {
      const explicitSha = entryForGit(kind, { ref: OTHER_PIN, sha: PIN });
      await expect(service(new Map()).inspect(inputForGit(new Map(), explicitSha, OTHER_PIN), new AbortController().signal))
        .rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED" });
      const explicitShaResult = await service(new Map()).inspect(
        inputForGit(new Map(), explicitSha, PIN),
        new AbortController().signal,
      );
      expect(explicitShaResult.ok, `${kind} explicit sha`).toBe(true);

      const shaRef = entryForGit(kind, { ref: PIN });
      await expect(service(new Map()).inspect(inputForGit(new Map(), shaRef, OTHER_PIN), new AbortController().signal))
        .rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED" });
      const shaRefResult = await service(new Map()).inspect(
        inputForGit(new Map(), shaRef, PIN),
        new AbortController().signal,
      );
      expect(shaRefResult.ok, `${kind} sha-shaped ref`).toBe(true);

      const namedRef = entryForGit(kind, { ref: "main" });
      const namedRefResult = await service(new Map()).inspect(
        inputForGit(new Map(), namedRef, NAMED_REF_REVISION),
        new AbortController().signal,
      );
      expect(namedRefResult.ok, `${kind} named ref`).toBe(true);
    }
  });

  it("consumes catalog-only foreign declarations into the complete bundle inventory", async () => {
    const files = new Map<string, Uint8Array>();
    const result = await service(files).inspect(
      makeInput(files, entryForClaude({ agents: "./agents" })),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components.foreign).toHaveLength(1);
    expect(result.value.components.foreign[0]).toMatchObject({
      nativeHost: "claude",
      nativeKind: { value: "agents" },
      declaration: { value: "./agents", provenance: [{ location: { pointer: "/plugins/0/agents" } }] },
    });
  });

  it("executes the committed prototype-pollution JSON fixture at the manifest boundary", async () => {
    const files = new Map([[".claude-plugin/plugin.json", fixtureBytes("../adversarial-bundles/prototype-json.json")]]);
    const result = await service(files).inspect(
      makeInput(files, entryForClaude()),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "MANIFEST_ROOT_INVALID" }] });
    expect(result).not.toHaveProperty("value");
  });

  it("turns invalid UTF-8 in an indexed skill into a failed result", async () => {
    const files = new Map([["skills/bad/SKILL.md", fixtureBytes("invalid-utf8.md")]]);
    const result = await service(files).inspect(
      makeInput(files, entryForClaude({ skills: "./skills" })),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "SCHEMA_INVALID" }] });
    expect(result).not.toHaveProperty("value");
  });

  it("turns invalid UTF-8 in indexed Codex presentation YAML into a failed result", async () => {
    const skill = text("---\nname: bad\ndescription: bad\n---\n");
    const files = new Map([
      ["skills/bad/SKILL.md", skill],
      ["skills/bad/agents/openai.yaml", Uint8Array.from([0xff, 0xfe, 0xfd])],
    ]);
    const result = await service(files).inspect(
      makeInput(files, entryForClaude({ skills: "./skills" })),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "SCHEMA_INVALID" }] });
    expect(result).not.toHaveProperty("value");
  });

  it("keeps unknown hook-handler fields as verifiable foreign inventory", async () => {
    const files = new Map([["hooks/hooks.json", text(JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo", futureRuntime: { enabled: true } }] }] },
    }))]]);
    const result = await service(files).inspect(
      makeInput(files, entryForClaude({ hooks: "./hooks/hooks.json" })),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components.hooks).toHaveLength(1);
    expect(result.value.components.foreign).toHaveLength(1);
    expect(result.value.components.foreign[0]).toMatchObject({
      nativeKind: { value: "hook-handler" },
      declaration: { provenance: [{ location: { pointer: "/hooks/SessionStart/0/hooks/0/futureRuntime" } }] },
    });
  });

  it("projects a plugin package.json pi.extensions block as a metadata-only foreign pi-extension component", async () => {
    const files = new Map([
      [".claude-plugin/plugin.json", text(JSON.stringify({ name: "demo" }))],
      ["package.json", text(JSON.stringify({ name: "pkg", pi: { extensions: ["./extensions"], skills: ["./skills"] } }))],
      ["skills/demo/SKILL.md", text("---\nname: demo\ndescription: demo skill\n---\n# demo\n")],
    ]);
    const result = await service(files).inspect(
      makeInput(files, entryForClaude()),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components.skills).toHaveLength(1);
    expect(result.value.components.foreign).toHaveLength(1);
    expect(result.value.components.foreign[0]).toMatchObject({
      kind: "foreign",
      nativeKind: { value: "pi-extension" },
      declarationSubkey: "pi.extensions",
      declaration: { value: ["./extensions"] },
    });
  });

  it("ignores a package.json without pi.extensions and never treats malformed JSON as a failure", async () => {
    const plain = new Map([
      [".claude-plugin/plugin.json", text(JSON.stringify({ name: "demo" }))],
      ["package.json", text(JSON.stringify({ name: "pkg" }))],
      ["skills/demo/SKILL.md", text("---\nname: demo\ndescription: demo skill\n---\n# demo\n")],
    ]);
    const plainResult = await service(plain).inspect(makeInput(plain, entryForClaude()), new AbortController().signal);
    expect(plainResult.ok).toBe(true);
    if (plainResult.ok) expect(plainResult.value.components.foreign).toHaveLength(0);

    const malformed = new Map([
      [".claude-plugin/plugin.json", text(JSON.stringify({ name: "demo" }))],
      ["package.json", text("{not json")],
      ["skills/demo/SKILL.md", text("---\nname: demo\ndescription: demo skill\n---\n# demo\n")],
    ]);
    const malformedResult = await service(malformed).inspect(makeInput(malformed, entryForClaude()), new AbortController().signal);
    expect(malformedResult.ok).toBe(true);
    if (malformedResult.ok) expect(malformedResult.value.components.foreign).toHaveLength(0);
  });

  it("preserves result, boundary, and abort semantics across the value and handoff boundaries", async () => {
    const entry = entryForClaude();
    const malformed = new Map([[".claude-plugin/plugin.json", text('{"name":"demo","name":"again"}')]]);
    const malformedResult = await service(malformed).inspect(
      makeInput(malformed, entry),
      new AbortController().signal,
    );
    expect(malformedResult).toMatchObject({ ok: false, diagnostics: [{ code: "MANIFEST_ROOT_INVALID" }] });

    const broken = createPluginInspectionService({
      content: { readFile: async () => { throw new Error("adapter unavailable"); } },
      readers: readers(),
      sha256,
    });
    await expect(broken.inspect(makeInput(new Map([[".claude-plugin/plugin.json", text("{}")]]), entry), new AbortController().signal))
      .rejects.toMatchObject({ code: "ADAPTER_FAILED" });

    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(service(malformed).inspect(makeInput(malformed, entry), controller.signal)).rejects.toBe(reason);
  });

  it("applies Node composition limits to the filesystem-backed manifest read", async () => {
    const root = new URL("../fixtures/plugins/dual-equivalent/", import.meta.url);
    const path = ".claude-plugin/plugin.json";
    const bytes = new Uint8Array(readFileSync(new URL(path, root)));
    const files = new Map([[path, bytes]]);
    const entry = entryForClaude();
    const input = makeInput(files, entry);
    const inspector = createNodePluginInspector({ limits: { manifestBytes: 1 } });
    await expect(inspector.inspect({
      ...input,
      materialized: { ...input.materialized, root: fileURLToPath(root) },
    }, new AbortController().signal)).rejects.toMatchObject({ code: "ADAPTER_FAILED" });
  });

  it("rejects wrong-kind required manifests before readers run", async () => {
    const entry = entryForCodex();
    const result = await service(new Map()).inspect(
      makeInput(new Map(), entry, [{ kind: "directory", path: ".codex-plugin", mode: 0o755 }, { kind: "directory", path: ".codex-plugin/plugin.json", mode: 0o755 }]),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "MANIFEST_ROOT_INVALID" }] });
  });

  it("forwards configured manifest, hook, and MCP byte limits to the content port", async () => {
    const cases = [
      {
        field: "manifestBytes" as const,
        path: ".claude-plugin/plugin.json",
        bytes: text('{"name":"demo"}'),
        entry: entryForClaude(),
        expectedCode: "MANIFEST_ROOT_INVALID",
      },
      {
        field: "hooksBytes" as const,
        path: "hooks/hooks.json",
        bytes: text('{"hooks":{}}'),
        entry: entryForClaude({ hooks: "./hooks/hooks.json" }),
        expectedCode: "MANIFEST_ROOT_INVALID",
      },
      {
        field: "mcpBytes" as const,
        path: ".mcp.json",
        bytes: text('{"local":{"command":"echo"}}'),
        entry: entryForClaude({ mcpServers: "./.mcp.json" }),
        expectedCode: "MANIFEST_ROOT_INVALID",
      },
    ];
    for (const testCase of cases) {
      const reads: Array<{ path: string; limit: number }> = [];
      const files = new Map([[testCase.path, testCase.bytes]]);
      const result = await service(files, reads, { [testCase.field]: 1 }).inspect(
        makeInput(files, testCase.entry),
        new AbortController().signal,
      );
      expect(result, testCase.field).toMatchObject({ ok: false, diagnostics: [{ code: testCase.expectedCode }] });
      expect(reads, testCase.field).toContainEqual({ path: testCase.path, limit: 1 });
    }
  });
});
