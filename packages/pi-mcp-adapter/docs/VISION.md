# VISION — @nklisch/pi-mcp-adapter

A maintained MIT fork of [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter):
the full MCP client bridging layer for Pi — stdio/HTTP servers, OAuth,
elicitation, sampling, MCP UI — **plus a programmatic configuration-source
lifecycle** the upstream package does not have. Other extensions register,
search, and call MCP tools through source-qualified gateways without owning
MCP plumbing.

## Product shape

- The Pi extension surface (`index.ts`) runs from TypeScript source and
  preserves upstream behavior and CLI parity.
- The programmatic entrypoint (`./programmatic`, built to `dist/`) is the
  fork's public API for other extensions: source-qualified process, tool,
  cache, and status identity; callback-scoped launch values; cancellation;
  runtime leases.
- pi-plugins is the primary downstream consumer; both exports are pinned by
  its provenance tests.

## Boundaries

Fork features layer on top of upstream — protocol semantics (OAuth flows,
elicitation, consent) stay spec-compliant and are never rewritten. The fork
does not add host-specific policy, state models, settings mutation,
generated configuration files, or parallel MCP SDK/transport/auth
implementations; changes outside the documented delta belong upstream first
(see `../MAINTAINING.md`).

## Fork posture

Track upstream releases and security notices; rebase the generic delta onto
verified upstream releases; contribute the source lifecycle upstream
(references upstream issue #85, prior PR #56). The fork retires only when
upstream bytes pass the unchanged qualification suite — package selection
changes, consumer contracts do not.
