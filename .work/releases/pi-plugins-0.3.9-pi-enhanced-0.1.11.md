---
release: pi-plugins-0.3.9-pi-enhanced-0.1.11
date: 2026-08-18
packages:
  - "@nklisch/pi-plugins@0.3.9"
  - "@nklisch/pi-enhanced@0.1.11"
items:
  - feature-support-pi-node-runtime-floor
---

# Node runtime compatibility release

## Pi Plugins 0.3.9

Plugin Host now supports Node 22.19 and newer. This range matches Pi's runtime floor. Compatible Node 22 hosts no longer report the command-hook adapter as unavailable because of a Node 24 version gate.

## Pi Enhanced 0.1.11

The enhanced bundle now declares Node 22.19 as its runtime floor and includes Pi Plugins 0.3.9.

## Compatibility and operations

- Node versions below 22.19 remain unsupported.
- Pi's structural extension API qualification remains unchanged.
- Publish Pi Plugins before Pi Enhanced so the bundle includes the corrected Plugin Host release.

## Verification

- `npm run check`
- Node 22.19 runtime qualification regression tests
- Node 22.19 built-extension import
- Research lint
- Workbench validation
- Knowledge-index validation
- Standard cross-model implementation review
