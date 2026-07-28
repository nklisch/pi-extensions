---
id: integer-format-normalization
kind: story
status: completed
tags: [fix, mcp]
created: 2026-07-26
completed: 2026-07-26
---

Deep-normalized MCP tool input schemas in pi-mcp-adapter to drop
integer-width `format` annotations TypeBox doesn't know, silencing
Ajv warnings for schemars-generated servers (krometrail). Evidence:
commits 0d83382, faf7eb9; schema-validator.ts + tests.
