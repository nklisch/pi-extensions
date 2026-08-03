---
id: mcp-gateway-discovery-redesign
kind: feature
status: completed
tags: []
created: 2026-06-14
completed: 2026-06-14
---

Redesigned pi-mcp-adapter's programmatic gateway discovery so agents stop
guessing MCP argument shapes. Every fresh connect now warms a persisted
tool inventory (`mcp-programmatic-cache.json`, keyed by qualified server
key); a `before_agent_start` block renders each server's tool names into
the system prompt without launching servers (cache-first, collapse past
50 tools/server, 300-name global budget); a batched `schema` action
serves raw JSON input schemas in one round-trip; failed calls append the
tool's exact schema from session memory; list/search label the owning
server by native key; static usage guidance moved into the gateway tool's
promptGuidelines. Design reviewed at standard weight (GLM-5.2, one pass);
the review's load-bearing finding — no programmatic metadata cache
existed — became the persistence unit. Evidence: 31 new/updated
programmatic extension, runtime, and cache tests; `npm run check` green;
VISION.md and README.md reconciled. MCP resources remain parked.
Released as @nklisch/pi-mcp-adapter 2.11.0-nklisch.8 with pi-plugins
0.3.0 carrying the sibling pin.
