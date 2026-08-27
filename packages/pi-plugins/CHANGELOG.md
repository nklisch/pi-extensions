## v0.6.2

### Fixed

- Rebundle `@nklisch/pi-subagents` 18.1.0-nklisch.4 so blocking result retrieval and completion notifications deliver each background-agent outcome only once.

## v0.6.1

### Fixed

- Require Pi coding-agent and TUI peers 0.82 or newer. This prevents an older peer selected for another bundled extension from shadowing the plugin manager's TUI import with an empty or incompatible nested package in `pi-enhanced` installations.

## v0.6.0

### Added

- Add a keyboard-first `/plugins` manager with Installed, Discover, Marketplaces, and Issues views; local search and details; explicit multi-select batches; cancellable marketplace checks; mixed-result reporting; and one reload when the manager closes after runtime changes.
- Add `.auto-update` authorization, bounded pre-activation updates for marked plugins with declared version changes, and `/plugins update-marked` to force-update every marked plugin—including unversioned entries—with one grouped refresh and one reload.

### Changed

- Add grouped marketplace refresh and sequential batch host APIs while keeping directories and marker files authoritative. Automatic updates preserve disabled state and installed copies remain active when refreshes or individual updates fail.
- Persist only the optional manager check-on-open preference; selections, progress, results, diagnostics, and reload state remain transient.

## v0.5.0

### Changed

- Replace the transactional plugin lifecycle with a filesystem-first host. Marketplaces are ordinary checkouts, installed plugin directories are authoritative, `.disabled` is the complete enablement model, and plugin data is the only persistent non-reproducible state.
- Discover skills, command hooks, and MCP declarations directly from installed bundles at extension load. Plugin MCP servers overlay the adapter's normal file discovery instead of replacing user/project MCP configuration. Mutations use temporary sibling directories and Pi's normal reload flow.
- Replace the custom manager and control protocol with concise `/plugins` commands and Pi's built-in selection, input, and confirmation UI.

### Removed

- Remove SQLite state, generations, document schemas and digests, CAS, immutable revision stores, projections, convergence and garbage collection, leases, automatic-update scheduling and notices, trust ledgers, repair/rollback, project synchronization, foreign-state adoption, and host-wide degradation accounting.
- Remove the implementation-mirroring test and E2E machinery for those deleted systems. Focused tests now cover path containment, safe copying, direct lifecycle operations, skill/hook/MCP discovery, and the Pi extension boundary.

## v0.4.2

### Fixed

- Rebundle `@nklisch/pi-subagents` 18.1.0-nklisch.3 so child teardown emits and awaits `session_shutdown`, and resume waits for Pi idle while rejecting concurrent resume admission deterministically.

## v0.4.1

### Fixed

- Contain detached update startup, subagent disposal, child-process completion, plugin-manager timers and install phases, hook presentation, and lifecycle cleanup. One failed reporting or cleanup sink no longer terminates Pi or suppresses later recovery work.

## v0.4.0

### Added

- Agent orientation at session start: agents see installed plugins with
  version, marketplace, component availability, and degraded status, plus a
  generated per-plugin brief with an explicitly user-facing command section.
- MCP candidate-attach failures surface as degraded host status with a
  doctor finding and remediation instead of silently disabling MCP.
- Reload broker tickets expire after two minutes, so a successor that never
  answers cannot hang a reload.
- Exact public export-surface pinning test.

### Changed

- Complete lifecycle convergence: interrupted installs, updates, and
  uninstall data deletion converge on the next start without durable recovery
  state; degraded revisions remain visible with repair and rollback actions.
- Reconcile the architecture and specification with files-and-pointer state,
  CAS mutation, mtime-grace cleanup, and live-next-start updates.

### Fixed

- Validate migration against a copy of the real pre-convergence plugin-host
  state, including the krometrail-class pending marker and journal evidence.

## v0.3.9

### Fixed

- Keep the command-hook adapter available on Node 22.19+ hosts, matching Pi's own supported runtime floor instead of unnecessarily requiring Node 24.

## v0.3.8

### Fixed

- Load the bundled subagent extension when Pi owns peer modules outside the package tree. The verified Jiti bridge now includes the public `@earendil-works/pi-ai/compat` subpath, so `subagent`, `get_subagent_result`, and `steer_subagent` remain registered after process restart.

## v0.3.7

### Changed

- Bump the bundled `@nklisch/pi-subagents` sibling to `18.1.0-nklisch.1`, adding exact thinking-level status and bounded 500 ms widget updates for long sessions.
- Bump the synchronized `@nklisch/pi-mcp-adapter` sibling to `2.20.1-nklisch.1`; adapter runtime behavior is unchanged.

## v0.3.6

### Fixed

- Staged updates no longer fence journal settlement to the staging process's
  lifetime. An automatic or sync-now update commits with deferred activation
  and returns `staged`, but the journal row kept `owner_pid` pointing at the
  staging session — and startup recovery in every *other* session defers on a
  live owner — so with concurrent Pi sessions the update sat in
  "needs recovery; restart pi to finish it" until the session that staged it
  exited (days, for a long-lived session). The lifecycle service now releases
  journal ownership at both staged return points (deferred activation and
  activation-unavailable), `ownerStatus` treats an ownerless prepared row as
  adoptable, and the release only ever clears the releasing process's own rows
  (immediate operations stay fenced while genuinely mid-flight). The next
  start of any session finalizes the staged revision, matching the documented
  "activates on the next Pi start or reload" contract. Rows staged by older
  versions still unlock only when their staging process exits.

## v0.3.5

### Fixes

- Add marketplaces on macOS instead of refusing staging because Linux `/proc` process-start evidence is unavailable. Staging, refresh claims, revision leases, and recovery journals now use native process-start queries on macOS/BSD and Windows, with a safe current-process fallback that leaves orphaned ownership unknown rather than blocking legitimate hosts.
- Explain marketplace registration failures with the exact actionable category and next step. The manager no longer reduces every rejected add to “wasn't allowed”; invalid sources, unavailable repositories, invalid catalogs, name conflicts, stale/corrupt state, trust/portability limits, and local storage failures now render distinct guidance.

## v0.3.4

### Removed

- Defanged the over-engineered filesystem-gate class in `infrastructure/state/local-lock-filesystem.ts`. `verifyLocalFilesystemCapability` was the third round of the same anti-pattern in this adapter (after `st_dev` identity in v0.2.3 and the sqlite file-identity machinery in v0.2.4): a Linux-style magic-number `f_type` allowlist that fails closed on every real macOS APFS/HFS+ volume because Node returns a vestigial `0x1a` on Darwin. The integer allowlist is now Linux-only — the single platform where `statfs.f_type` actually carries a disk magic — and is a no-op everywhere else. (The original table also had `win32` and `freebsd` entries with Linux-style magics; libuv returns `0` on Windows and FreeBSD's `f_type` is the kernel-assigned `vfc_typenum`, so those entries had been silently failing closed the entire time — masked only because nobody runs pi-plugins there.) `ensurePrivateLockRoot` no longer walks every path component rejecting any symlink; the 0o700 leaf check is the actual security boundary, and the ancestor walk only ever broke OS-managed symlinks like macOS `/tmp → /private/tmp`. The capability-gate test that masked the regression (it accepted either failure or success) now asserts the host-platform behavior deterministically, and a new test pins the no-op behavior on every non-Linux platform. Foundation docs (`SPEC.md`, `ARCHITECTURE.md`) reconciled against the v0.2.4-removed identity markers and the new gate behavior. Recorded as a project principle in `docs/PRINCIPLES.md` and `AGENTS.md`. Fixes issue #2.

## v0.3.3

### Changed

- Bump the pinned `@nklisch/pi-mcp-adapter` sibling to `2.20.1-nklisch.0`. The independent MCP runtime now includes current Codex TOML discovery, SDK v2 protocol negotiation, safer credential/config merging, session recovery, secure standalone OAuth storage, ranked agent discovery, approvals, prompts, scripting, and hardened MCP Apps while preserving Plugin Host's source-qualified lifecycle and compact schema-on-demand gateway.

## v0.3.2

### Changed

- Bump the pinned `@nklisch/pi-mcp-adapter` sibling to `2.11.0-nklisch.10`, carrying current Codex user and project TOML MCP configuration support into the release bundle.

## v0.3.1

### Fixes

- Bump the pinned `@nklisch/pi-mcp-adapter` sibling to `2.11.0-nklisch.9`: gateway `schema` results and schema-on-error output render collapsed in the transcript (three lines, Ctrl+O to expand) instead of dumping raw JSON into the chat; the model still receives the full schema.

## v0.3.0

### Changed

- Bump the pinned `@nklisch/pi-mcp-adapter` sibling to `2.11.0-nklisch.8`: the programmatic MCP gateway gains cache-warmed system-prompt tool discovery, a batched `schema` action with raw JSON input schemas, and schema-on-error enrichment for failed calls. Plugin-contributed MCP servers (for example Krometrail) now surface their tool names in the system prompt and let agents load exact argument schemas instead of learning them from validation errors.

## v0.2.4

### Removed

- Removed the sqlite file-identity machinery from every plugin-host adapter (scope lock, lifecycle state, transition journal, revision leases, revision retention): `.identity` database markers, `.initializing` claims, root identity markers, device/inode validation, hard-link handle aliases, and per-transaction root re-verification. The guards false-positive-broke normal operation after every routine reboot on btrfs/overlayfs (v0.2.3 state store and project keys, then the scope lock again) while never catching a real replacement. Schema first use now serializes inside one exclusive SQLite transaction, and the scope lock is simply the held `BEGIN IMMEDIATE` transaction — a killed holder is released by the OS. Private directory modes, symlink rejection, the local-filesystem capability gate, schema/protocol validation, busy retry, and journal row digests are unchanged. Marker files left by older versions are inert debris and require no cleanup.

## v0.2.3

### Fixes

- Stop treating `st_dev` as stable file identity. btrfs (and overlayfs et al.) assign anonymous device numbers per mount, so every reboot changed device while files and inodes were unchanged — the host then hard-failed startup with "SQLite database identity marker does not match its path", and project keys rotated each mount epoch, orphaning project-scoped state. Identity acceptance is now inode-based (device remains recorded as forensic metadata), and the repository fingerprint preimage drops device (one-time project-key rotation; the old keys were already unstable per mount epoch).
- Startup failures now inline the underlying cause chain in the extension error message instead of the bare "packaged plugin host startup failed".

## v0.2.1

### Fixes

- Pass desktop session variables (`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`) through to standard-I/O MCP servers when present on the host, so servers that spawn graphical processes (browser automation, screenshot capture) can reach the user's session instead of dying at startup. Explicit template declarations take precedence; absent or empty host values are omitted; credential-bearing variables remain declaration-only.

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
