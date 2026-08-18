---
source_handle: agy-1-1-13-builtin-customizations
fetched: 2026-08-15
source_title: Antigravity CLI 1.1.13 built-in agy-customizations guide
---

This attestation records the documentation bundled inside the locally installed Antigravity CLI 1.1.13 at `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/`. It is a product-bundled primary source but has no stable public URL.

## Attested details

1. `plugins.md` defines a plugin as `plugins/<plugin_name>/plugin.json` plus optional `mcp_config.json`, `hooks.json`, `rules/`, and `skills/<skill_name>/SKILL.md`; it describes skills, rules, hooks, and MCP servers as automatically ingested when enabled.
2. `plugins.md` says the manifest `name` is optional and defaults to the directory name, while the running CLI validator rejects a manifest without `name`.
3. `plugins.md` says plugins are discovered from standard customization roots such as `.agents/plugins/` or explicitly registered through `plugins.json`; enabled state is stored separately in `config.json`, with a manifest `disabled` default overridden by the user's persisted choice.
4. `hooks.md` defines a named-hook object at the document root. Each named hook may contain `enabled` and event arrays for `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, and `Stop`.
5. For `PreToolUse` and `PostToolUse`, `hooks.md` uses grouped entries containing a regex `matcher` and nested command `hooks`; invocation and stop events use flat command-handler arrays. Commands receive camelCase JSON on stdin and return event-specific JSON on stdout.
6. `hooks.md` documents behavior not equivalent to the current Claude/Codex shared hook envelope: pre-tool decisions include `allow`, `deny`, `ask`, and `force_ask` plus shallow argument overwrite; pre/post invocation may inject steps; post invocation may force continuation or termination; stop may continue the loop.
7. `skills.md` requires `.agents/skills/<skill_name>/SKILL.md` with YAML `name` and `description`, and recommends progressive disclosure through linked references, helper scripts, and verification steps.
8. `rules.md` documents hierarchical `GEMINI.md` and `AGENTS.md` discovery from the working directory to repository root. Plugin rules are active only when the plugin is enabled.
9. `mcp_servers.md` defines a wrapped `mcpServers` object with stdio declarations (`command`, `args`, `env`) and remote declarations using `serverUrl`; the broader current public MCP page additionally documents `cwd`, headers, OAuth, Google credentials, disabled servers, and disabled tools.
10. `json_configs.md` defines `skills.json` and `plugins.json` as path-registration documents with `entries`, recursive `inherits`, and regex `include_only`/`exclude` filters; paths may be absolute, home-relative, or workspace-relative.
11. The parent `agy-customizations/SKILL.md` says rules may use `trigger: model_decision` or `always_on`, while `docs/rules.md` says standalone `GEMINI.md` and `AGENTS.md` do not support frontmatter and are always active. The bundled guidance therefore does not settle trigger semantics for plugin rule files.
12. Neither `plugins.md` nor the current public manifest schema documents a plugin `version` field.
13. `hooks.md` says hook commands run with the directory containing `hooks.json` as their working directory; it documents common conversation/workspace/transcript/artifact/model payload fields but no plugin-root or plugin-data environment variables.
14. `mcp_servers.md` describes `serverUrl` as remote SSE transport, while the broader current public MCP page describes the same field as Streamable HTTP or SSE. The declaration alone does not distinguish those remote protocols.
