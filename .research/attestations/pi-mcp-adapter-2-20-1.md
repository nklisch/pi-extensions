---
source_handle: pi-mcp-adapter-2-20-1
fetched: 2026-08-06
source_title: nicobailon/pi-mcp-adapter v2.20.1 source and changelog
source_url: https://github.com/nicobailon/pi-mcp-adapter/tree/1dbdef96f674410ac37067de70f10a3de3d48d98
---

The upstream Git repository was cloned and the immutable `v2.20.1` release commit, changelog, source tree, tests, package metadata, and history since `v2.11.0` were inspected. This attestation describes only what that source states or implements.

## Attested details

1. **Release identity.** Tag `v2.20.1` resolves to commit `1dbdef96f674410ac37067de70f10a3de3d48d98`; its package manifest declares version `2.20.1`. (`package.json`; Git tag)
2. **Change volume.** The range from the `v2.11.0` release commit `82724dccc13a49310530898f922bafff12b7f3fe` through `v2.20.1` contains 191 commits and changes 162 tracked paths. (`git log`; `git diff --stat`)
3. **Credential rebinding.** Version 2.12.0 drops inherited HTTP authorization when a higher-precedence configuration repoints a server URL while retaining explicit OAuth-disable intent. (`CHANGELOG.md`, 2.12.0 Fixed; `config.ts`)
4. **Runtime reliability.** Version 2.12.0 fences runtime ownership across Pi reloads, recovers invalidated Streamable HTTP sessions, supports lazy keep-alive, and cleans up abandoned initialization. Later releases remove a double-close race and the throwaway Streamable HTTP initialization probe. (`CHANGELOG.md`, 2.12.0, 2.16.0, 2.20.0; `runtime-owner.ts`; `session-recovery.ts`; `server-manager.ts`)
5. **Agent discovery surface.** The source provides ranked paginated search, typo suggestions, compact TypeScript-shaped parameter descriptions, server instructions, structured connection diagnoses, prompts as slash commands, disabled servers, and direct-tool refresh behavior. (`CHANGELOG.md`, 2.12.0, 2.13.0, 2.18.0; `search-ranking.ts`; `ts-shape.ts`; `prompts.ts`; `mcp-probe.ts`)
6. **Scripting surface.** Version 2.19.0 enables the `mcpScript` tool by default for trusted JavaScript multi-call workflows. Calls still pass through authentication, output guards, and approvals; execution occurs in a terminable worker and emits call traces. (`CHANGELOG.md`, 2.18.0–2.20.0; `mcp-code.ts`; `mcp-script-worker.mjs`; `skills/mcp-scripting/SKILL.md`)
7. **Approval surface.** Per-server/global approval patterns cover proxy, direct, resource, iframe, and scripted calls, and 2.20.0 adds a broker event for external permission extensions. (`CHANGELOG.md`, 2.18.0 and 2.20.0; `tool-approval.ts`)
8. **MCP Apps UI.** The current source sandboxes provider HTML, supplies restrictive default content policy, separates resource/session authority, validates frame message sources and context updates, honors model/app tool visibility, supports remote/Moshi opening, and preserves bounded context handoff. (`CHANGELOG.md`, 2.18.0–2.20.0; `host-html-template.ts`; `ui-server.ts`; `ui-session.ts`; `ui-tool-visibility.ts`)
9. **OAuth storage.** Version 2.13.0 migrates persistent OAuth credentials from plaintext files to operating-system credential storage with one-way legacy import and fail-closed behavior. Follow-up releases handle large records, revoked Linux keyrings, and absent stores. (`CHANGELOG.md`, 2.13.0–2.18.0; `mcp-auth.ts`; `mcp-keyring-helper.cjs`)
10. **Protocol implementation.** Version 2.20.0 migrates to stable modular MCP SDK v2 packages and adds configurable protocol negotiation while preserving conservative legacy discovery fallback. (`CHANGELOG.md`, 2.20.0; `package.json`; `server-manager.ts`; `types.ts`)
11. **Codex support.** Version 2.12.0 adds `.codex/config.toml` imports with JSON fallback. (`CHANGELOG.md`, 2.12.0; `config.ts`; `cli.js`)
12. **Static programmatic configuration only.** Upstream exposes `createMcpAdapter({ config, configPath })`, but the inspected source does not implement the maintained fork's source-qualified registration, exact replacement/removal, callback-scoped launch values, or revision leases. (`index.ts`; repository search for the fork's programmatic source symbols)
