# Changelog

## v0.2.2

### Changed

- Ship native engine prebuilds for Windows x64, Windows ARM64, Intel Mac, and Linux ARM64 in addition to the existing Linux x64 and Apple Silicon Mac prebuilds. The native platform gate (`packages/pi-clearance/src/native/loader.ts`) maps every common dev platform to its napi-rs suffix; previously only `linux-x64-gnu` and `darwin-arm64` had prebuilds and the extension refused to arm on Intel Macs, Linux ARM64 (RPi/Graviton), and Windows. CI and publish matrices build all six targets using native ARM runners (`ubuntu-24.04-arm`, `windows-11-arm`) and Apple-Silicon-to-Intel cross-compile (the `macos-13` Intel runner is being retired December 2025). Recorded as a project principle in `docs/PRINCIPLES.md`: a fail-closed guard must defend against a real threat, and a missing prebuild on a common platform is not one.
