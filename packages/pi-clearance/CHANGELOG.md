# Changelog

## v0.2.3

### Fixed

- Refresh the active-session footer immediately after a confirmed settings, scope, pack, or approved proposal change. Config writes now publish the freshly resolved policy to the operator-status controller instead of leaving the old mode visible until the next gated tool call or session restart.
- Isolate Clearance tests from real user config on macOS, Linux, and Windows with a package-wide throwaway home plus per-fixture platform config roots.

## v0.2.2

### Changed

- Ship native engine prebuilds for Windows x64, Windows ARM64, Intel Mac, and Linux ARM64 in addition to the existing Linux x64 and Apple Silicon Mac prebuilds. The native platform gate (`packages/pi-clearance/src/native/loader.ts`) maps every common dev platform to its napi-rs suffix; previously only `linux-x64-gnu` and `darwin-arm64` had prebuilds and the extension refused to arm on Intel Macs, Linux ARM64 (RPi/Graviton), and Windows. CI and publish matrices build all six targets using native ARM runners (`ubuntu-24.04-arm`, `windows-11-arm`) and Apple-Silicon-to-Intel cross-compile (the `macos-13` Intel runner is being retired December 2025). Recorded as a project principle in `docs/PRINCIPLES.md`: a fail-closed guard must defend against a real threat, and a missing prebuild on a common platform is not one.
