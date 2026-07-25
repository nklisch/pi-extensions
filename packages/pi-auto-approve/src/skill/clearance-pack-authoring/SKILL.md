---
name: clearance-pack-authoring
description: >
  Agent-facing guide for authoring Pi Clearance data packs, core matcher design inputs,
  and package-distributed pack collections. Use it when building or reviewing packs so
  agents validate/replay changes and preserve install-versus-enable separation before any
  user-owned enablement write.
---

# Clearance Pack Authoring

Use this skill when the user wants to write, review, package, or explain
Pi Clearance packs.

This is a thin workflow guide. Do not copy matcher catalogs, config schemas, package
registration payloads, or long validation rules into the conversation. Read the canonical
docs first and point future agents back to them.

## Read first

1. [PACK_AUTHORING.md](../../../docs/PACK_AUTHORING.md) — canonical workflow for data packs,
   core matcher design inputs, and package-distributed collections.
2. [CONFIGURATION.md](../../../docs/CONFIGURATION.md) — user-owned `packs` and
   `packEnablement` config shape.
3. [RATCHET.md](../../../docs/RATCHET.md) — proposal cards, replay evidence, approval, and
   writer boundaries.

## Required boundaries

- Prefer data packs. If the JSON matcher DSL can express the policy, use it instead of
  executable code.
- Installing a Pi package makes package packs available in the registry. It does not enable
  them or relax policy.
- Package pack enablement is a separate user-owned config action through
  `packEnablement.enabledPackagePacks` or the Pi pack command workflow.
- Trusted TypeScript rule modules are cut. They are never discovered, loaded, or enabled;
  use inspectable data packs or record a core matcher design input instead.
- sealed-floor validation, Replay/validation, and user approval precede any write that broadens
  user-owned policy.

## Workflow

1. Start from repeated history or a clear package authoring request.
2. Check whether a shipped or package-contributed pack already fits.
3. If authoring is needed, draft the smallest data pack first.
4. If the DSL cannot express a reusable need, propose a core matcher/design input rather than
   jumping straight to TypeScript.
5. Show validation results, replay impact, warnings, exact diffs or enablement patches, and
   required acknowledgments before asking the user to approve a write.
7. Keep package distribution docs and skills thin; link to `docs/PACK_AUTHORING.md` as the
   source of truth.
