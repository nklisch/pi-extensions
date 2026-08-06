---
version: pi-enhanced-0.1.3
date: 2026-08-06
items: [feature-native-package-distribution]
---

# pi-enhanced 0.1.3

Pi Enhanced now installs and starts Pi Clearance on macOS arm64 and Linux x64 glibc.

## What changed

- **Both native targets ship in the existing package.** Pi Clearance bundles prebuilt Linux x64 glibc and macOS arm64 engines without creating platform-specific npm packages.
- **Pi Enhanced carries the complete engine.** Its bundled Pi Clearance dependency includes both native artifacts, so installation requires no Rust toolchain or install script.
- **Release jobs build both targets.** Publishing fails unless CI has staged every declared native artifact.
- **Package checks cover distribution contracts.** Validation checks native metadata, bundled contents, public entries, and Pi resources.

## Compatibility and operations

- Pi Clearance moves from 0.1.0 to 0.1.1.
- Pi Enhanced moves from 0.1.2 to 0.1.3.
- Existing package-level OIDC trusted publishing remains the only release path; no new npm packages or local bootstrap are required.
- The native artifacts increase the installed package size in exchange for deterministic cross-platform installation.

## Verification

- A clean copied checkout completed `npm ci` and package validation.
- Native loader tests ran against Linux and macOS artifacts in CI.
- Release validation requires publish-faithful tarballs to contain both targets.
- `npm run check` passed across every publishable package.
