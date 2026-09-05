---
release: plugin-manager-and-session-fixes-2026-09-04
date: 2026-09-04
packages:
  - "@nklisch/pi-plugins@0.8.2"
  - "@nklisch/pi-conveniences@0.1.3"
  - "@nklisch/pi-legible@0.1.2"
  - "@nklisch/pi-enhanced@0.4.1"
items:
  - plugin-manager-versions-and-layout
  - extension-session-context-isolation
  - astral-pocket
---

# Accurate plugin versions, a clearer manager, and session-safe extensions

## Pi Plugins 0.8.2

Installed and locally discoverable versions come from native bundle manifests,
with installed receipts and catalog versions as fallbacks. Existing receipts
are read without migration, and newer catalog versions never replace the
installed-version display. Marked updates detect manifest-only releases,
including remote sources, and install the candidate that was inspected.
Explicit forced updates still support plugins without declared versions.

The manager uses a native-themed outer frame, height-bounded views, scrolling,
and keyboard selection that stays visible. Long confirmations show effects and
controls before the selected-plugin list. Failed checks remain visible in
Issues, and aggregated runtime warnings are not duplicated.

If a final replacement rename fails, the prior plugin or checkout is restored.
If restoration also fails, the previous copy is retained and its location is
reported for recovery. Persistent plugin data and update authorization remain
unchanged.

## Pi Conveniences 0.1.3 and Pi Legible 0.1.2

Extra project instructions follow Pi's active workspace context rather than a
nonexistent event field. Late prose rewrites are discarded after cancellation,
session replacement, shutdown, or configuration reload, without leaking
originals or returning an obsolete message.

## Pi Enhanced 0.4.1

The bundled note-pocket extension provides persistent notes and recall for
`openai-codex/gpt-6-astra`, bounded activation-time distillation, and explicit
pocket controls. It is inactive for other models. Session recall can expose
past tool output; keep summarized recall unless exact excerpts are needed.

Pi Enhanced includes the note-pocket extension and rebundles the corrected
plugin manager and workspace-context loader. Pi Legible remains a standalone
optional install. Standalone publication of `pi-astral-pocket` 0.1.0 is deferred;
its bundled inclusion is unchanged. Unrelated in-progress Ollama work is excluded.

## Verification

The implementation passed the repository's full `npm run check`, focused
regressions, native Catppuccin visual inspection, and one standard inline review
with accepted corrections. Regression coverage includes native-manifest
precedence, missing/stale receipts, remote updates, cancellation, replacement
failures, terminal sizing, confirmations, diagnostics, and session isolation.

The versioned release also passed `npm run check`, including bundle and tarball
inspection. Each package's publishing workflow repeated the repository gate.

## Publication

All four packages were published successfully through trusted GitHub Actions
publishing. npm reports each version as `latest`, with provenance attestations.
Standalone `pi-astral-pocket` 0.1.0 remains unpublished. A clean temporary npm
install of Pi Enhanced 0.4.1 with lifecycle scripts disabled succeeded and
confirmed bundled Pi Plugins 0.8.2, Pi Conveniences 0.1.3, and Pi Astral Pocket
0.1.0. The temporary installation was removed; the user's installed Pi packages
were not changed.

- Pi Plugins 0.8.2: [workflow 33934749134](https://github.com/nklisch/pi-extensions/actions/runs/33934749134).
- Pi Conveniences 0.1.3: [workflow 33936386411](https://github.com/nklisch/pi-extensions/actions/runs/33936386411).
- Pi Legible 0.1.2: [workflow 33936870931](https://github.com/nklisch/pi-extensions/actions/runs/33936870931).
- Pi Enhanced 0.4.1: [workflow 33937285863](https://github.com/nklisch/pi-extensions/actions/runs/33937285863).
