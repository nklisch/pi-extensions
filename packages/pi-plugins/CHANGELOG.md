# Changelog

## v0.1.5

### Features

- Unify installed and available plugins on one Plugins surface with All, Installed, Available, and Updates lenses navigated by Left/Right.
- Add direct top-level shortcuts: `A` installs the selected plugin, `U` updates the selected plugin, `Ctrl+U` explicitly updates all eligible plugins, and `M` opens Marketplaces.
- Keep trusted installation review and progress inside the mounted Plugins surface instead of replacing it with another custom screen.

### Fixes

- Preserve Add intent while exact candidate detail loads, then continue installation automatically instead of requiring a second Add.
- Cache exact plugin details by authority-bearing row identity and refetch only after explicit refresh, stale evidence, marketplace changes, or mutations.
- Show installed plugins as installed, consistently call catalog registrations Marketplaces, and expose exact-detail diagnostics instead of leaving detail loading stuck.

## v0.1.4

### Features

- Open `/plugin` immediately and refresh installed, discoverable, update, and health state in the background with visible loading feedback.
- Replace the section/action ladder with a two-layer catalog and inline plugin details, actions, progress, and results.
- Combine installed and discoverable plugins with All, Installed, and Updates filters while keeping sources one shortcut away.

### Fixes

- Deduplicate equivalent Claude/Codex and user/project candidates by immutable source identity while preserving the available installation scopes.
- Keep the manager mounted during actions, return cleanly from finished operations, and start every invocation at the catalog root.
- Remove redundant confirmations for routine reversible actions while retaining trust and destructive-change approval.

## v0.1.3

### Fixes

- Replace the pane-heavy `/plugin` marketplace UI with a stable settings-style flow: sections, items, details, then actions.
- Make Escape return exactly one level, keep PageUp/PageDown tied to visible selection, and preserve the same single-column interaction model at every terminal size.
- Remove obsolete tab, split-pane, and disclosure focus state while retaining exact trust review in the dedicated install and confirmation surfaces.

## v0.1.2

### Features

- Redesign `/plugin` around My Plugins, Discover, Sources, Updates, and Health, with first-run source onboarding and state-sensitive actions.
- Add concise `add`, `remove`, and `doctor` commands while retaining prior command forms as compatibility aliases.

### Fixes

- Replace garbled experimental confirmation overlays with framed, correctly sized full-screen confirmation and secret-entry surfaces.
- Render useful bounded command results and concise help instead of command-description placeholders.
- Activate the bundled subagent extension from one top-level Pi installation by bridging Pi's existing coding-agent, AI, and TUI module identities into the receipt-verified child loader.
- Keep installed counts stable across manager sections and expose actual host diagnostics through Health.

### Documentation

- Document the distinction between Pi extension packages and managed foreign plugin bundles, the simplified command surface, and transitive runtime activation.

## v0.1.1

### Fixes

- Make marketplace registration host-global while preserving independent user/project plugin installation targets.
- Default `/plugin marketplace add owner/repository` to GitHub shorthand and remove marketplace scope flags from add, remove, list, refresh, and adoption commands.
- Project global marketplace catalogs into scope-specific candidate identities so project installs no longer require duplicated project marketplace registration.
- Keep project intent and V4 state valid when scoped plugins depend on the host-global marketplace registry.

### Documentation

- Clarify global marketplace ownership, plugin scope semantics, and the simplified marketplace command forms.

## v0.1.0

### Features

- Install and manage compatible Claude Code and Codex marketplaces without either foreign host, with read-only adoption of foreign marketplace declarations.
- Activate Agent Skills, command hooks, and MCP servers as one revision-bound plugin across install, enable, disable, update, and uninstall.
- Manage plugins through the Pi-native interface or deterministic `plugin-control/v1` commands, including inspection, diagnosis, update policy, notices, and operation control.
- Ship receipt-qualified maintained MCP and subagent integrations with plugin-scoped lifecycle and faithful subagent hook interception.

### Fixes

- Make lifecycle mutations transactional across processes, with exact conflict handling, crash recovery, rollback, offline restart, and persistent-data retention choices.
- Keep update discovery non-blocking and separate from automatic application while preserving the active revision on acquisition, validation, compatibility, or activation failure.

### Security

- Enforce source and redirect authority, DNS-pinned egress, hardened Git/npm/archive acquisition, canonical YAML/JSON boundaries, and redacted control output.
- Verify exact package SRI, installed trees, manifests, APIs, licenses, and runtime ranges before maintained adapter code executes; capability drift and unavailable secret custody fail closed.
- Keep MCP launch values callback-scoped and sensitive plaintext absent from durable state, projections, diagnostics, logs, and terminal/control output.

### Documentation

- Align architecture, specification, compatibility, and auto-loading integration references with the shipped runtime contracts and known MCP alias limitation.
- Verify the release from an empty dependency tree through packed lock/SRI replay, complete V1-to-V2 runtime lifecycle, contention and recovery, offline restart, and post-uninstall absence.
