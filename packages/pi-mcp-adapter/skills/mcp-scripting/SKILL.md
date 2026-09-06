---
name: mcp-scripting
description: Write mcpScript JavaScript for discovering, inspecting, and calling MCP tools.
---

# MCP scripting

For multi-call MCP work, write ordinary JavaScript with loops, filtering, chaining, fan-out, or other logic between calls. Run that source with `mcpScript`; it is the primary MCP orchestration surface. For a single MCP search, describe, status check, auth action, or tool call, use `mcp` instead.

Write the source naturally, then pass it as `mcpScript`'s `code` argument:

```js
const { items, coverage } = await tools.search({ query: "search issues", server: "github" });
if (!coverage.complete) return { action: "connect with the top-level mcp tool, then retry", omittedServers: coverage.omittedServers };
const candidate = items[0];
if (!candidate) return { error: "No matching tool" };

const details = await tools.describe({ path: candidate.path });
if (details.error) return details;

const result = await tools.call(details.path, { query: "is:open label:bug" });
if (!result.ok) return result;
emit({ tool: details.path, completed: true });
return result.data;
```

## Workflow

1. Find candidate tools with `await tools.search({ query, server?, limit?, offset? })`.
   Search never connects servers. If `coverage.complete` is false, return the omitted catalogs and use each suggested top-level `mcp({ connect: "name" })` or auth action before concluding a capability is absent. Unknown and disabled server filters are errors, not successful empty searches.
2. Inspect the exact returned path with `await tools.describe({ path })`.
   Describe includes exact `inputSchema` and advertised `outputSchema`; TypeScript shapes are previews. Output schemas describe `data.structuredContent`, not the call envelope. Preserve referenced definitions and constraints when constructing arguments.
3. Call it with `tools.call(path, args)`.

Calls resolve to `{ ok: true, data }` or `{ ok: false, error }`; `data` is the server's decoded result (text, structured content, images), even when the persisted details were summarized to stay bounded. Handle failed calls instead of expecting them to stop the script. `emit(value)` adds user-visible output before the final `return` value. `console` output is captured too.

`tools` is a non-enumerable proxy: `Object.keys(tools)` throws. Always use `tools.search` for discovery. When a known flat path is a valid identifier, direct calls such as `tools.github_search_issues(args)` are supported; use bracket syntax for hyphenated names: `tools["server_tool-name"](args)`. `search`, `call`, `describe`, and promise/serialization names (`then`, `catch`, `finally`, `toJSON`, `toString`, `valueOf`) are reserved on the proxy; if a flat path collides with one, call it via `tools.call("exact-path", args)`.

`tools.search` and `tools.describe` are asynchronous and must be awaited. The default script timeout is 30 seconds; the worker is terminated at the deadline, including for infinite loops. Every invocation still uses normal lazy connection, authentication, output guarding, and approval gates. Result details contain a concise `calls` trace with every search, describe, and call operation; each entry includes its query or path, outcome, and duration.

Use plain JavaScript loops and Promise utilities for composition. Fluent helpers such as `tools.find(...).one()`, `tools.parallel(...)`, and `tools.retry(...)` are not provided.
