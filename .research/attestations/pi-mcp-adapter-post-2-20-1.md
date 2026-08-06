---
source_handle: pi-mcp-adapter-post-2-20-1
fetched: 2026-08-06
source_title: nicobailon/pi-mcp-adapter fixes after v2.20.1 through 08fe82b
source_url: https://github.com/nicobailon/pi-mcp-adapter/compare/v2.20.1...08fe82be1d55036d3960c4bb3fa77ed8707f2bca
---

The upstream Git range immediately after `v2.20.1` was fetched and inspected through immutable commit `08fe82be1d55036d3960c4bb3fa77ed8707f2bca`.

## Attested details

1. Commit `4fa22b30e95e88ec124b63c9b4bd7987dcc01195` replaces raw optional numeric tool schemas with real TypeBox numeric schemas, preventing enumerable `~optional` markers from reaching provider tool definitions while retaining a fallback for older host shims. (`index.ts`; `__tests__/index-lifecycle.test.ts`)
2. Commit `78e46c702c496de0f303f173101ca13aa6d929db` forwards the validated RFC 9207 callback `iss` value into SDK authorization-code completion. (`mcp-auth-flow.ts`; `__tests__/mcp-auth-flow-client-credentials.test.ts`)
3. Commit `023e85f6e09527afea69cf7985c5719ba0332633` adds an exported inverse tool-prefix resolver for permission systems. It chooses the longest configured prefix and returns no owner when distinct server names normalize to the same prefix. (`types.ts`; `__tests__/resolve-server-from-tool-name.test.ts`)
4. Commit `08fe82be1d55036d3960c4bb3fa77ed8707f2bca` adds a plain-schema fallback when TypeScript-shaped scripting descriptions cannot represent an input schema, and caches repeated collapsed transcript layouts at the same width. (`mcp-code.ts`; `tool-result-renderer.ts`; associated tests)
