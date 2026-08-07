---
id: feature-clearance-native-platform-coverage
kind: feature
status: completed
tags: [security, native, platform-support, anti-pattern]
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
created: 2026-09-14
updated: 2026-09-14
---

# Ship pi-clearance to Windows, Intel Mac, and Linux ARM64

Closed the most serious remaining instance of the same fail-closed
anti-pattern documented in `docs/PRINCIPLES.md`: pi-clearance only
shipped `linux-x64-gnu` and `darwin-arm64` prebuilds and
`requireNativeEngine()` threw on miss, refusing to arm on Intel Macs,
Linux ARM64, Windows, and everything else.

## Outcome

`@nklisch/pi-clearance` activates on every common dev platform. The
native loader (`packages/pi-clearance/src/native/loader.ts`) maps all
six common combinations; `package.json` declares six napi targets; CI
and publish matrices build all six using native ARM runners
(`ubuntu-24.04-arm`, `windows-11-arm`) plus Apple-Silicon-to-Intel
cross-compile (the `macos-13` Intel runner is being retired Dec 4 2025).
`scripts/native-packages.mjs` and `packages/pi-enhanced/test/verify-bundle.mjs`
both updated to map all six Rust triples to napi-rs suffixes.

## Closure evidence

- `npm run check` green (2742 pi-clearance tests, 1798 pi-plugins tests,
  all workspace builds, typecheck, pack inspection).
- Local `cargo check --target x86_64-pc-windows-msvc --workspace` proved
  the Rust source is portable; only `cc-rs`'s C toolchain lookup failed
  (expected on a Linux box without MSVC). Windows/Linux-ARM/macOS-Intel
  builds will be verified in CI; the work item records that CI is the
  verification for those targets.
- New `native-loader.test.ts` test asserts the production
  `nativePlatformTriple` dispatch directly (not a test-local copy),
  covering all six platforms plus `freebsd`/`aix` undefined cases.
- `SPEC.md:18` and `ARCHITECTURE.md:33` reconciled from "two artifacts"
  / "Linux x64 + macOS arm64" to the full six-platform coverage.
- CHANGELOG created (`packages/pi-clearance/CHANGELOG.md`).
- Cross-model review (GPT-5.6 Sol) surfaced three findings, all
  addressed: the Linux-only refinement of the filesystem magic-number
  table (blocker — win32/freebsd entries were silently broken), the
  pi-clearance foundation doc reconciliation (major), and asserting the
  production platform dispatch from the test (minor).

## Parked

- Truly-unsupported platforms (BSD, Solaris, AIX): the loader still
  refuses to arm on those. The user's chosen scope was to close the
  common dev platform gap. BSD/Solaris graceful-degradation can follow
  if a real user shows up; recorded in the PRINCIPLES.md anti-pattern
  entry so it does not get forgotten.
