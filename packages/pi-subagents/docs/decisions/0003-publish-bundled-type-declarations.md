# 0003 — Publish bundled declarations for the public surface

## Context

Consumers must be able to import `@nklisch/pi-subagents` by package name without
adopting its internal path aliases or source layout. Following the internal type
graph directly can make a consumer's own `#src/*` aliases intercept imports meant
for this package. Packaging must not require restructuring the domain model to
satisfy another project's compiler configuration.

## Decision

Publish self-contained declaration bundles for the root service and `./settings`
exports, while runtime consumers continue to load TypeScript source.

- `dist/public.d.ts` describes the root service contract.
- `dist/settings.d.ts` describes the layered-settings helper.
- The manifest's `types` conditions point to those bundles; runtime export targets
  remain the corresponding source modules.
- The declaration build inlines internal types while leaving peer-dependency types
  external. It does not generate a second JavaScript runtime.
- Declarations are generated at pack time, shipped through the package allowlist,
  and not committed. The manifest and declaration build configuration own exact
  paths and build inputs.

Packed public types must compile in an external consumer without workspace path
privileges. A workspace-linked consumer also needs the generated declarations
available before typechecking against the package.

## Alternatives considered

An alias-free public entry could avoid declaration bundling, but would require
reorganizing the type graph for a packaging concern. Re-declaring public types in
a separate entry would instead duplicate contract truth and require keeping both
copies synchronized. A generated declaration bundle avoids both costs.

## Consequences

The build is narrow: declarations for the public contract, not a replacement for
Pi's source-loading model. Consumers use the packaged interface rather than
reaching into internal source modules. Public type changes carry the same
compatibility obligations as the runtime service they describe.
