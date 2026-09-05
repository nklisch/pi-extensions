---
id: plugin-manager-versions-and-layout
kind: feature
status: completed
owner: workbench
created: 2026-09-04
completed: 2026-09-04
---

# Show accurate plugin versions in a clearly bounded manager

Native bundle metadata now supplies installed and local catalog versions, with
receipt/catalog fallbacks and manifest-aware marked updates for remote sources.
Existing receipts and plugin preferences are not migrated. The manager has a
native-themed frame, height-bounded navigation, readable confirmations, and
truthful, nonduplicated issues. Failed final renames preserve the prior copy.

Verified with focused regressions, the full `npm run check` gate, a read-only
native Catppuccin preview, and one standard inline review with corrections.
README, specification, architecture, and unreleased changelog are reconciled.
Package publication and installed-package replacement were not requested.
