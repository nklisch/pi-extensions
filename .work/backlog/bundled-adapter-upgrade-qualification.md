---
id: bundled-adapter-upgrade-qualification
tags: []
created: 2026-09-06
updated: 2026-09-06
---

# Pi package update leaves empty adapter directory

- Kind: friction
- Status: open
- Observed/proposed: 2026-09-06
- Surface: setup (Pi package installation; not an ncu defect)

## Goal or use case

Upgrade the local Pi bundle to use the published MCP result-delivery fix.

## Observation and evidence

`pi update npm:@nklisch/pi-enhanced` returned success for 0.4.3, but Pi then reported `Cannot find module '@nklisch/pi-mcp-adapter'` loading the bundled Plugin Host entry. The expected nested adapter directory existed but was empty. npm lockfiles and `npm ls` reported `.3` as installed, with `inBundle: true`. Fresh-install qualification had passed; upgrade behavior was not thereby established. Cause remains unknown.

## Environment

Linux, Pi 0.85.1, Node 24.17.0, npm 11.18.0; Enhanced 0.4.2 → 0.4.3, Host 0.8.3, Adapter 2.21.0-nklisch.3. No ncu operation or desktop input was involved.

## Workaround and follow-up

Restored only the empty directory from the exact published adapter tarball after checking SHA-512 against the existing installation lock. Configuration and lockfiles unchanged. The actual installed host entry then passed Pi's file-extension loader and synthetic registered-tool/result-hook checks in a fresh isolated process. User-session restart and live-browser qualification remain separate. A permanent upgrade-path fix requires reproduction; workaround does not close this incident.

Owning evidence: `/home/nathan/dev/pi-extensions/.work/releases/structured-result-delivery.md`, section “Installed upgrade incident”.

## NCU feedback assessment, 2026-09-06

This remains an external installation incident, not an NCU defect. Permanent
resolution requires isolated qualification of the 0.4.2 → 0.4.3 upgrade and the
next accepted candidate, resolving the adapter from the actual installed host
entry and loading that entry through Pi. Fresh packing tests alone do not prove
the upgrade. The independently active Pi reliability owner should retain this
requirement; no speculative bundle or runtime repair was added in NCU.


## Relocation context

Related existing evidence: `.work/releases/structured-result-delivery.md` and `.work/releases/mcp-agent-reliability.md`. Fresh-consumer installation of the newer release does not establish that the reported in-place upgrade failure is corrected.
