---
release: pi-enhanced-0.4.2
date: 2026-09-05
packages:
  - "@nklisch/pi-enhanced@0.4.2"
bundled_packages:
  - "@nklisch/pi-astral-pocket@0.2.0"
items:
  - reliable-astral-pocket
---

# Repository-scoped Astral Pocket memory

Pi Enhanced 0.4.2 bundles Astral Pocket 0.2.0.

## Memory scope

Notes and automatic distillation default to the current repository. Subdirectories and linked worktrees share its local identity. Explicit global notes carry general preferences or conditional portable lessons. Other repositories enter recall only through an intentional `scope: "all"` request and are labeled precedent, not current instructions.

Injected memory contains only the current repository and explicit global notes. Current user instructions and repository guidance take precedence over remembered facts. Unknown-scope legacy notes remain available through broad recall but are not injected globally. Existing note files are not migrated.

## Distillation and recall

The default distiller is Astra at minimal reasoning. Commands select the model and reasoning level, enable or disable extraction, show status, and rebuild digests. Requests resolve authentication through Pi without silently changing providers. Status distinguishes requested and effective reasoning when Pi maps levels.

Changed sessions refresh their generated note. Digests rebuild from scoped source notes, including deliberate notes, rather than from older summaries. Failed generation remains retryable. Missing caches rebuild, and stale cached facts are not injected after source changes. Session changes, configuration changes, disablement, and shutdown cancel outdated work.

Recall returns note content even when only metadata matches. Larger excerpts work for notes and sessions. Results are bounded to 20 per source, and transcript extraction retains chronology and recent decisions.

## Limits

Files remain the storage format. Pi's write queue is process-local, not a cross-process transaction system. Simultaneous Pi processes can duplicate calls or publish competing derived snapshots. Source notes remain available for rebuilding.

Distillation sends bounded source text to the selected provider. Model instructions reduce sensitive-data and instruction-poisoning risks but cannot guarantee their removal.

## Verification

All 52 package tests and typecheck passed. The final versioned `npm run check` passed across the repository, including bundle and tarball inspection. One standard implementation review completed, with its accepted findings corrected and reverified.

A small synthetic judgment check found no quality difference among Astra minimal, Astra low, and Luna low on five cases. The harness mapped the attempted Astra off run to minimal. This was not a production benchmark or a model ranking.

The loaded Workbench validator still reports three pre-existing issues: the old `.work/archive/` directory and an unrelated completed item without an id. This release does not reconcile that substrate or include unrelated completed outcomes. Unrelated Ollama work is excluded.

## Publication

Pi Enhanced 0.4.2 was published through [trusted workflow 33957529024](https://github.com/nklisch/pi-extensions/actions/runs/33957529024) from commit `7f7a0f345039204f5cbd40946c559e7d9541de6f`. npm reports it as `latest` with a provenance attestation.

A clean temporary install with Pi 0.82.0 loaded the published extension and confirmed bundled Pocket 0.2.0, Astra/minimal defaults, scoped tools, the recall limit, and shutdown registration. Lifecycle install scripts were disabled. The temporary installation was removed, and the user's installed packages were not changed.

An unconstrained temporary install selected Pi 0.85.0 and installed successfully, but the extension import probe failed on that host's missing `@earendil-works/pi-server` dependency. This release does not claim verification on Pi 0.85.0.

Standalone Astral Pocket publication remains deferred: the package has no registry release, and local account access is unavailable for its first-publication setup. The Pi Enhanced bundle is the delivery path.
