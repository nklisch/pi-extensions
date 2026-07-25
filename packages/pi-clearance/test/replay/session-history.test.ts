import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  createSessionFileSource,
  createSessionHistorySource,
  projectSessionToolCalls,
  type ReadonlySessionManager,
} from "../../src/replay/sources/session-history.ts";

function messageEntry(options: {
  readonly id: string;
  readonly timestamp: string;
  readonly role?: string;
  readonly content: unknown;
}): SessionEntry {
  return {
    type: "message",
    id: options.id,
    parentId: null,
    timestamp: options.timestamp,
    message: {
      role: options.role ?? "assistant",
      content: options.content,
    },
  } as unknown as SessionEntry;
}

function compactionEntry(id: string, timestamp: string): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp,
    summary: "compacted context",
    firstKeptEntryId: id,
    tokensBefore: 123,
  } as unknown as SessionEntry;
}

function branchSummaryEntry(id: string, timestamp: string): SessionEntry {
  return {
    type: "branch_summary",
    id,
    parentId: null,
    timestamp,
    fromId: "earlier-entry",
    summary: "abandoned branch",
  } as unknown as SessionEntry;
}

function fakeSessionManager(options: {
  readonly sessionId?: string;
  readonly entries?: readonly SessionEntry[];
  readonly branch?: readonly SessionEntry[];
}): ReadonlySessionManager {
  return {
    getSessionId: () => options.sessionId ?? "session-1",
    getEntries: () => [...(options.entries ?? [])],
    getBranch: () => [...(options.branch ?? [])],
  } as unknown as ReadonlySessionManager;
}

describe("session history source", () => {
  it("projects assistant toolCall blocks into session tool calls", () => {
    const result = projectSessionToolCalls(
      [
        compactionEntry("compaction-1", "2026-06-25T09:59:00.000Z"),
        branchSummaryEntry("branch-1", "2026-06-25T09:59:30.000Z"),
        messageEntry({
          id: "assistant-1",
          timestamp: "2026-06-25T10:00:00.000Z",
          content: [
            {
              type: "toolCall",
              id: "tool-bash",
              name: "bash",
              arguments: { command: "git status --short" },
            },
            {
              type: "toolCall",
              id: "tool-read",
              name: "read",
              arguments: { path: "README.md" },
            },
            { type: "text", text: "not a tool call" },
          ],
        }),
        messageEntry({
          id: "user-1",
          timestamp: "2026-06-25T10:01:00.000Z",
          role: "user",
          content: [
            {
              type: "toolCall",
              id: "tool-user",
              name: "bash",
              arguments: { command: "should not project" },
            },
          ],
        }),
      ],
      "session-1",
    );

    expect(result.warnings).toEqual([]);
    expect(result.items).toEqual([
      {
        toolCallId: "tool-bash",
        toolName: "bash",
        command: "git status --short",
        toolInput: { command: "git status --short" },
        sessionId: "session-1",
        timestamp: "2026-06-25T10:00:00.000Z",
      },
      {
        toolCallId: "tool-read",
        toolName: "read",
        command: '{"path":"README.md"}',
        toolInput: { path: "README.md" },
        sessionId: "session-1",
        timestamp: "2026-06-25T10:00:00.000Z",
      },
    ]);
  });

  it("applies since, maxToolCalls, and sessionId bounds", () => {
    const entries: readonly SessionEntry[] = [
      messageEntry({
        id: "assistant-1",
        timestamp: "2026-06-25T10:00:00.000Z",
        content: [
          {
            type: "toolCall",
            id: "tool-old",
            name: "bash",
            arguments: { command: "git status" },
          },
        ],
      }),
      messageEntry({
        id: "assistant-2",
        timestamp: "2026-06-25T10:01:00.000Z",
        content: [
          {
            type: "toolCall",
            id: "tool-mid",
            name: "bash",
            arguments: { command: "pnpm check" },
          },
        ],
      }),
      messageEntry({
        id: "assistant-3",
        timestamp: "2026-06-25T10:02:00.000Z",
        content: [
          {
            type: "toolCall",
            id: "tool-new",
            name: "bash",
            arguments: { command: "pnpm test" },
          },
        ],
      }),
    ];

    const bounded = projectSessionToolCalls(entries, "session-1", {
      sessionId: "session-1",
      since: "2026-06-25T10:00:30.000Z",
      maxToolCalls: 1,
    });

    expect(bounded.warnings).toEqual([]);
    expect(bounded.items.map((item) => item.toolCallId)).toEqual(["tool-new"]);

    const mismatched = projectSessionToolCalls(entries, "session-1", {
      sessionId: "other-session",
    });

    expect(mismatched.items).toEqual([]);
    expect(mismatched.warnings).toEqual([
      "session session-1 did not match requested session other-session; skipped",
    ]);
  });

  it("uses the current branch when leafBranchOnly is set", () => {
    const allEntries = [
      messageEntry({
        id: "assistant-all",
        timestamp: "2026-06-25T10:00:00.000Z",
        content: [
          {
            type: "toolCall",
            id: "tool-all",
            name: "bash",
            arguments: { command: "git status" },
          },
        ],
      }),
    ];
    const branchEntries = [
      messageEntry({
        id: "assistant-branch",
        timestamp: "2026-06-25T10:01:00.000Z",
        content: [
          {
            type: "toolCall",
            id: "tool-branch",
            name: "bash",
            arguments: { command: "pnpm check" },
          },
        ],
      }),
    ];

    const source = createSessionHistorySource({
      sessionManager: fakeSessionManager({
        entries: allEntries,
        branch: branchEntries,
      }),
      bounds: { leafBranchOnly: true },
    });

    expect(source.read().items.map((item) => item.toolCallId)).toEqual([
      "tool-branch",
    ]);
  });

  it("reads offline session JSONL files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-auto-approve-session-"));
    try {
      const path = join(dir, "session.jsonl");
      const header = {
        type: "session",
        id: "file-session",
        timestamp: "2026-06-25T09:00:00.000Z",
        cwd: "/tmp/project",
      };
      const message = {
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-06-25T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-file",
              name: "bash",
              arguments: { command: "pnpm test" },
            },
          ],
        },
      };
      await writeFile(
        path,
        `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`,
        "utf8",
      );

      const result = createSessionFileSource({ path }).read();

      expect(result.warnings).toEqual([]);
      expect(result.items).toEqual([
        {
          toolCallId: "tool-file",
          toolName: "bash",
          command: "pnpm test",
          toolInput: { command: "pnpm test" },
          sessionId: "file-session",
          timestamp: "2026-06-25T10:00:00.000Z",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty result with a warning for missing session files", () => {
    const result = createSessionFileSource({
      path: "/definitely/missing/session.jsonl",
    }).read();

    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("could not read session file");
  });
});
