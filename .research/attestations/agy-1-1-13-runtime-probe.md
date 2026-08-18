---
source_handle: agy-1-1-13-runtime-probe
fetched: 2026-08-15
source_title: Read-only and temporary-home probes of Antigravity CLI 1.1.13
---

This attestation records commands run against the locally installed `agy` binary. Validation fixtures and installation state were created only in temporary directories; no persistent Antigravity plugin state was changed. The installed updater status reported “Already on the latest version.”

## Attested details

1. `agy --version` returned `1.1.13`; the updater status reported that this was the latest installed release on 2026-08-15.
2. `agy plugin --help` listed `list`, `import`, `install`, `uninstall`, `enable`, `disable`, `validate`, and `link`; install described support for `plugin@marketplace`, while import described Gemini or Claude sources.
3. `agy plugin validate` accepted a root `plugin.json` containing `{"name":"minimal"}` and rejected `{}` with `plugin.json missing name`.
4. The validator accepted a bundle containing `$schema`, `name`, `description`, a nested Agent Skill, `rules/AGENTS.md`, an `agents/*.md` custom subagent, wrapped MCP configuration, and the named-root Antigravity hook format. It reported skills, agents, MCP servers, and hooks as processed.
5. The validator accepted manifest `disabled: true`, despite the public page's displayed schema allowing no property beyond `name` and `description`.
6. The validator accepted both `skills/<name>/SKILL.md` and a flat `skills/<name>.md` skill; its report also checks a `commands` component that is absent from the installed plugin-layout guide.
7. Installing a validated local plugin under a temporary `HOME` copied it to `~/.gemini/config/plugins/<name>/`, wrote `~/.gemini/config/import_manifest.json`, and recorded the imported component inventory. This matches the 1.0.4 changelog statement that installation moved to shared `~/.gemini/config/`, not the current public page's private application-data path.
8. The 1.1.11 changelog says plugin enablement moved exclusively to `config.json`, seeded once from each manifest, so a later manifest default does not overwrite the user's persisted choice.
9. The 1.1.7 changelog records a defect where disabled plugins still ran hooks and other customizations, confirming that enablement is intended to gate the complete bundle.
10. The 1.0.9 and 1.0.8 changelog entries report Git-submodule support and direct installation from GitHub subpaths, while the current public plugin page does not specify those remote source contracts.
11. Attempts to import a synthetic Claude marketplace through a temporary `~/.claude/plugins/known_marketplaces.json` produced “No claude extensions found”; this bounded probe did not establish Antigravity's marketplace file format or registry state contract.
