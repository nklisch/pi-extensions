---
id: integer-format-normalization
title: Normalize JSON Schema integer formats in pi-mcp-adapter
status: complete
created: 2026-07-26
tags: [fix, mcp]
---

# Integer format normalization

MCP servers that generate schemas with schemars (krometrail) annotate
integers with `format: int32|int64|uint32|uint64`. TypeBox's format
registry knows none of these and logs `unknown format "..." ignored in
schema` warnings at tool registration (27 of 52 krometrail tools).

## Accepted requirements

- Symptom (user-confirmed): TypeBox format warnings.
- End state (user-chosen): krometrail fully working through the
  pi-plugins gateway with types normalized at the adapter boundary.
  Krometrail is already a host plugin (`.mcp.json` in plugin staging);
  no re-wiring needed once the adapter normalizes.

## Approach

Deep-normalize tool input schemas in the adapter: drop `format` values
TypeBox doesn't know (format is annotation-only per JSON Schema; TypeBox
ignores unknown formats anyway, so behavior is unchanged minus noise).

## Acceptance

- No TypeBox warnings when registering all 52 krometrail tools.
- Model-visible schema otherwise unchanged; validation behavior unchanged.
- Full repo check green; pi-mcp-adapter + pi-plugins released in sync.
