---
id: pi-plugins-ux-fixes
kind: story
status: active
tags: [fix, ux, pi-plugins]
created: 2026-07-28
updated: 2026-07-28
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
---

# pi-plugins UX fixes

User-reported issues in @nklisch/pi-plugins:

1. **"Update available" never resolves** — FIXED. Root cause: `mergePluginCatalogRows` decorated installed rows from ALL notice rows including resolved tombstones (retention keeps up to 64/plugin). Now filters to unresolved only.
2. **Trust failures hard-fail instead of prompting** — FIXED. New `trust.grant` control command (`/plugins trust <plugin> --scope X --yes`) wrapping a new InstalledTrustGrantService (exact-revision verification + live compatibility re-assessment + ExactTrustGrantService). Manager "Trust plugin" action with confirmation surface. Session-start TUI review prompts "Trust X again?" for trust-required blocked plugins (max 3, TUI only), grants, advises /reload (session contexts carry no reload authority). Required widening `runWithPiOperationContext` to ExtensionContext; complete-plugin-reload guards reload authority at runtime.
3. **`/plugin` → `/plugins`** — DONE: registration, collision name, all user-facing strings, README/SPEC/ARCHITECTURE, tests (SPEC tables regenerated via doc contract test).
4. **Plugin selection lacks scope separation** — FIXED: [user]/[project] badge on every manager list row (project accent-colored).

Out of scope: the failed "Publish Pi extension" CI run 30326599220 was the pre-trust pi-legible first-publish attempt (ENEEDAUTH), superseded by local publish + `npm trust`. Not a bug.

## Acceptance

- [x] Update-available decoration clears once a notice is resolved
- [x] Trust-required at runtime surfaces a continue/re-trust prompt, not a failure
- [x] `/plugins` command works (collision semantics preserved via pi's name:occurrence suffixing)
- [x] Manager list visually separates project vs user scope
- [x] `npm run check` green (1778 pi-plugins tests + full repo gate incl. e2e)
- [ ] Cross-model review (gpt-5.6-sol) findings adjudicated
- [ ] Version bump 0.1.23 → 0.2.0 + publish via CI
