---
version: pi-enhanced-0.1.3
date: 2026-08-06
items: [feature-native-package-distribution]
---

# pi-enhanced 0.1.3

Pi Enhanced now installs and starts Pi Clearance on macOS arm64 and Linux x64 glibc.

## What changed

- **Native packages cover both supported platforms.** Pi Clearance uses scoped, exact-version platform packages for Linux x64 glibc and macOS arm64.
- **Pi Enhanced forwards native dependencies.** npm installs the correct native engine even though Pi Enhanced bundles Pi Clearance.
- **Release jobs build both targets.** The publisher releases native packages before Pi Clearance and Pi Enhanced.
- **Package checks cover distribution contracts.** Validation now checks native metadata, bundled optional dependencies, public entries, and Pi resources.

## Compatibility and operations

- Pi Clearance moves from 0.1.0 to 0.1.1.
- Pi Enhanced moves from 0.1.2 to 0.1.3.
- The first native-package publish requires npm trust setup. Later publishes use the existing OIDC workflow.
- Installation does not build Rust. npm selects a prebuilt native package for the host platform.

## Verification

- A clean copied checkout completed `npm ci` and package validation.
- Linux exercised the installed optional-package loader path.
- Native package staging produced publish-faithful tarballs for both targets.
- `npm run check` passed across all 13 publishable packages.
