# Pi Plugins

Native plugin management for [Pi](https://github.com/badlogic/pi-mono), with compatibility for supported Claude Code and Codex marketplaces.

`@nklisch/pi-plugins` provides:

- marketplace discovery, inspection, and read-only foreign-state adoption;
- transactional install, enable, disable, update, recovery, and uninstall;
- Agent Skills and command-hook activation;
- receipt-qualified MCP and subagent lifecycle integration;
- deterministic `/plugin` commands and a Pi-native interactive manager;
- offline-safe startup, update policy, diagnostics, and multiprocess coordination.

## Requirements

- Node.js 24 or newer
- Pi 0.80.8-compatible public extension APIs

## Install

```bash
pi install npm:@nklisch/pi-plugins
```

Then start Pi and run `/plugin`. The manager uses the same progressive list footprint as Pi settings: choose **My Plugins**, **Discover**, **Sources**, **Updates**, or **Health**, then drill into an item and its available actions. Escape returns one level. On a clean installation, open Sources and choose **Add Source**, or use:

```text
/plugin marketplace add nklisch/skills
/plugin add <plugin@marketplace> --scope user
```

`/plugin add` adds the complete plugin to the selected user or project plugin list, collects any required configuration and executable trust, installs and enables it, and reloads Pi when activation changes. Use `/plugin help` for the concise command surface:

```text
/plugin add <plugin> --scope user|project
/plugin remove <plugin> --scope user|project --keep-data|--delete-data
/plugin update <plugin> --scope user|project
/plugin enable <plugin> --scope user|project
/plugin disable <plugin> --scope user|project
/plugin list
/plugin doctor [plugin]
/plugin marketplace add|list|refresh|remove ...
```

The older `install`, `uninstall`, and `diagnose` forms remain accepted as compatibility aliases. Workflow-phase and operation-token routes remain available to automation but are intentionally omitted from normal help and completion.

Marketplace registration is global; plugin installation remains user- or project-scoped. GitHub shorthand is the default marketplace source. Use `--source-kind git` or `--source-kind local-git` for those source forms. The interactive manager opens only in a TUI session.

This package manages compatible foreign marketplace plugins as complete bundles. It does **not** replace Pi's package manager: use `pi list`, `pi install`, `pi update`, and `pi config` for ordinary Pi extension packages.

## Security

Pi packages execute with full local-system access. Review the source and requested plugin trust before installation. Sensitive plugin configuration currently fails closed when production cannot prove atomic operating-system credential ownership; plaintext is never retained in plugin-host state, projections, diagnostics, logs, or control output.

Marketplace-derived network access is origin-authorized and DNS-pinned. Credential-bearing MCP endpoints require HTTPS; unauthenticated plaintext HTTP is limited to explicitly approved literal loopback endpoints.

## Compatibility

The current production package pins and verifies:

- `@nklisch/pi-mcp-adapter@2.11.0-nklisch.0`
- `@nklisch/pi-subagents@18.0.4-nklisch.0`

Executable dependencies are receipt-checked before import. The MCP and subagent packages are transitive dependencies: one top-level `pi install npm:@nklisch/pi-plugins` installs and activates both through verified wrappers, so they do not need separate `pi install` entries. The bundled subagent loader reuses Pi's already-loaded coding-agent, AI, and TUI module identities rather than installing a second Pi runtime tree. Package, API, runtime-range, installed-tree, or behavioral drift makes the affected capability unavailable rather than partially activating it.

See [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) for the complete compatibility contract.

## License

MIT © 2026 Nathan Klisch
