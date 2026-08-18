---
source_handle: antigravity-cli-official-plugins
fetched: 2026-08-15
source_title: Plugins & Skills — Google Antigravity CLI
source_url: https://antigravity.google/docs/cli/plugins
---

Google's current public Antigravity CLI page describes plugins as staged, namespaced bundles and documents their layout, manifest, lifecycle commands, and relationship to skills. The page is internally inconsistent in several places, so the details below preserve those differences rather than selecting one silently.

## Attested details

1. Under “Antigravity plugins,” plugins are namespaced bundles that may package skills, background subagents, rules, MCP definitions, and event hooks.
2. Under “Plugin filesystem structure,” the documented bundle root contains required `plugin.json` and optional `mcp_config.json`, `hooks.json`, `skills/`, `agents/`, and `rules/` paths.
3. Under “The plugin manifest,” the page says `name` is required, constrained to `^[a-zA-Z0-9-_]+$`, and used by CLI commands; `description` is optional.
4. The displayed JSON Schema sets `additionalProperties: false`, defines only `name` and `description`, and requires `name`.
5. The manifest example also includes a `$schema` property, although `$schema` is absent from the displayed schema's properties and would therefore conflict with its `additionalProperties: false` rule.
6. Under “Managing plugins,” the documented lifecycle is `agy plugin list`, `install`, `disable`, `enable`, and `uninstall`; disabling preserves plugin assets while uninstalling removes them.
7. The page says installation accepts a local or remote plugin, but shows only a local path and does not document a remote source, marketplace catalog, archive, or registry contract.
8. Under “Creating local workspace skills,” the page documents workspace skill Markdown files directly under `.agents/skills/`; this differs from the nested `skills/<name>/SKILL.md` shape in the installed customization guide.
9. The page says installed plugin files are staged under `~/.gemini/antigravity-cli/plugins/<plugin_name>/`; observed CLI 1.1.13 behavior and its changelog instead place installed plugins under the shared `~/.gemini/config/plugins/` directory.
10. Fetching the page's advertised schema URL, `https://antigravity.google/schemas/v1/plugin.json`, returned HTTP 404 on 2026-08-15, so that URL could not independently settle the manifest contradiction.
