---
release: plugin-manager-and-session-fixes-2026-09-04
date: 2026-09-04
packages:
  - "@nklisch/pi-plugins@0.8.2"
  - "@nklisch/pi-conveniences@0.1.3"
  - "@nklisch/pi-legible@0.1.2"
  - "@nklisch/pi-astral-pocket@0.1.0"
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

## Pi Astral Pocket 0.1.0 and Pi Enhanced 0.4.1

The first note-pocket release provides persistent notes and recall for
`openai-codex/gpt-6-astra`, bounded activation-time distillation, and explicit
pocket controls. It is inactive for other models. Session recall can expose
past tool output; keep summarized recall unless exact excerpts are needed.

Pi Enhanced includes the note-pocket extension and rebundles the corrected
plugin manager and workspace-context loader. Pi Legible remains a standalone
optional install. Unrelated in-progress Ollama work is excluded.

## Verification

The implementation passed the repository's full `npm run check`, focused
regressions, native Catppuccin visual inspection, and one standard inline review
with accepted corrections. Regression coverage includes native-manifest
precedence, missing/stale receipts, remote updates, cancellation, replacement
failures, terminal sizing, confirmations, diagnostics, and session isolation.

The versioned release also passed `npm run check`, including bundle and tarball
inspection. Publication is pending trusted-publisher setup for the new
note-pocket package and the manual GitHub Actions release workflow.
