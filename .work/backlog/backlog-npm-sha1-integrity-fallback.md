---
id: backlog-npm-sha1-integrity-fallback
kind: story
status: active
tags: [security, plugin-host, anti-pattern]
parent: null
blocked_by: []
related_to: [feature-defang-filesystem-gate-class]
research_refs: []
mock_refs: []
created: 2026-09-14
updated: 2026-09-14
---

# Allow npm SHA-1 integrity fallback when SHA-512 is absent

> Workbench version mismatch: stop and offer setup upgrade.

Parked from the pi-plugins filesystem-gate defang. Identified during the
audit as the next instance of the same anti-pattern
(`docs/PRINCIPLES.md`: fail-closed guards must defend against a real threat).

## Observation

`packages/pi-plugins/src/infrastructure/npm/npm-registry-client.ts:187-189`
throws `SOURCE_RESOLUTION_FAILED` whenever an npm packument version lacks a
SHA-512 integrity hash. Many pre-2015 npm packages and many private/corporate
registries publish only `sha1-` integrity (the historical npm default).
Resolving any of those versions hard-fails source resolution with no override.

The strict stance reads as careful but defends against nothing real: npm
itself accepts `sha1-` integrity and verifies tarballs against it. A SHA-1
*collision* on a registry tarball is a much harder attack than simply
publishing a malicious tarball with a valid SHA-512 (the registry trusts the
publisher either way). The check is ceremony.

## Why parked, not done in the parent delivery

The branded `NpmIntegritySchema` (`packages/pi-plugins/src/domain/source.ts:288`)
is a public, exported type pinned to a strict SHA-512 regex. It is consumed by
the source domain, the subagent lifecycle port, the npm registry client, and
the verification path (which hard-codes `record.integrity.slice("sha512-".length)`
at `npm-registry-client.ts:351`). Widening to accept SHA-1 (or any SRI hash
npm accepts) touches the source domain model and the verification path; it is
its own coherent change with its own review surface, not a tail of the
filesystem-gate defang.

## Approach when picked up

- Widen `NpmIntegritySchema` to accept `sha1-`, `sha256-`, `sha384-`, and
  `sha512-` SRI digests (canonical base64 lengths per algorithm).
- Replace the hard-coded `slice("sha512-".length)` in `downloadNpmTarball`
  with a generic SRI parser that selects the right hash function.
- Keep the default bias toward SHA-512 (most recent packs continue to ship
  SHA-512); the change is purely about not refusing SHA-1-only packs.
- Update tests that currently assert the SHA-512 mandatory throw.

## Threat model (one sentence, per `docs/PRINCIPLES.md`)

A malicious publisher can already publish a tarball with any integrity hash
the registry accepts; the SHA-512 mandatory throw does not stop them, it only
breaks legitimate resolution of older packs.

## Sequencing

None — independent follow-up.
