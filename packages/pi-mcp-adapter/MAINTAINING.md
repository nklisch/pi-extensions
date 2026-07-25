# Maintained fork policy

This package is a narrow MIT-licensed fork of
[`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter).
It exists only to carry the generic programmatic configuration-source lifecycle
until equivalent released upstream bytes pass the same qualification.
Its home is the `nklisch/pi-extensions` monorepo (`packages/pi-mcp-adapter`);
pre-monorepo history lives in the `nklisch/pi-mcp-adapter` fork repository.

## Provenance

- Upstream base package: `pi-mcp-adapter@2.11.0`
- Upstream base commit: `82724dccc13a49310530898f922bafff12b7f3fe`
- Upstream tag: `v2.11.0`
- npm package: `@nklisch/pi-mcp-adapter`, published through `2.11.0-nklisch.3`
- Security reports: private GitHub security-advisory channel on the fork's
  home repository
- License: MIT; the upstream `LICENSE`, copyright, authorship, Git history,
  README, changelog, CLI, extension entry, and runtime files are retained.

The repository and npm namespace did not exist when this candidate was created.
The version above is not publication evidence. A release exists only after the
immutable registry and GitHub receipts in the publication checklist are filled.

## Scope boundary

Maintainers may carry only:

1. the typed `./programmatic` package export;
2. exact source registration, compare-and-replace, removal, inspection, and
   complete capability reporting;
3. source-qualified process/tool/cache/status identity;
4. immediate callback-scoped launch values, cancellation, and runtime leases;
5. tests and documentation required to prove those contracts; and
6. minimal internal seams that let the existing manager consume already-resolved
   launch values and disable legacy-SSE fallback for exact Streamable HTTP.

Do not add host-specific policy, state models, settings mutation, generated
configuration files, process-global secret injection, manager deep exports, or
parallel MCP SDK/transport/authentication implementations. Changes outside this
boundary belong upstream first.

## Ownership and security intake

Nathan Klisch owns npm publication, GitHub repository administration, security
triage, upstream rebases, and emergency unpublishing/deprecation decisions.
Security reports go through the private GitHub security-advisory channel.

For an upstream security release or high-impact protocol fix:

1. fetch `upstream/main` and all release tags;
2. verify npm `latest`, npm `gitHead`, the GitHub release tag, and the candidate
   upstream commit independently;
3. rebase the generic commits onto the newest release commit when the contract
   remains valid; use a merge only when preserving a non-linear upstream fix is
   materially safer;
4. rerun the full upstream suite, source-lifecycle suite, packed-package Node 24
   test, no-source parity, Pi ordering/isolation, cancellation, redaction, and
   downstream conformance qualification; and
5. publish a new immutable version rather than rewriting a tag or npm version.

Routine upstream release checks occur at least monthly and before every fork
publication. Critical upstream security notices are evaluated immediately.

## Qualification commands

Run on Node 24 from a clean monorepo checkout:

```bash
npm install
npm install --prefix packages/pi-mcp-adapter/examples/interactive-visualizer --package-lock=false --ignore-scripts
npm run build --prefix packages/pi-mcp-adapter/examples/interactive-visualizer
npm test --workspace @nklisch/pi-mcp-adapter
npm run test:package --workspace @nklisch/pi-mcp-adapter
npm pack --dry-run --workspace @nklisch/pi-mcp-adapter
```

The visualizer build is an existing upstream-suite prerequisite: its generated
`dist/` fixtures are intentionally ignored and are not fork source changes.
Then install the exact local tarball into an isolated consumer and run the
Plugin Host adapter-neutral MCP contract unchanged. The qualification adapter
may map package values to host schemas, but it must import only the packed
`@nklisch/pi-mcp-adapter/programmatic` export and must not edit Plugin Host's
production adapter, capability composition, package manifest, or lockfile.

Required evidence:

- ordinary default extension and CLI parity;
- initial sources visible before Pi tool registration;
- disabled file/import/cache discovery;
- exact identity isolation through process/tool/cache/status paths;
- atomic stale/failure rollback and exact idempotent removal;
- pre-abort and in-flight cancellation;
- launch-value disposal and runtime-lease release on all outcomes;
- redaction canaries absent from status, diagnostics, logs, and packed metadata;
- exact Streamable HTTP without legacy-SSE fallback;
- package exports deny manager deep imports; and
- MIT license included in the tarball.

## Publication checklist

Publication is an operator action through the monorepo's trusted-publishing
workflow. Never infer these receipts from a local build.

1. Choose a final immutable version in a release commit (`npm version ...
   --workspace @nklisch/pi-mcp-adapter --no-git-tag-version`).
2. Rerun all qualification against the exact release commit (`npm run check`).
3. Dispatch the **Publish Pi extension** workflow for `pi-mcp-adapter`.
4. Record all of the following together:
   - npm version and `sha512` integrity;
   - npm tarball URL and registry publication time;
   - npm `gitHead`;
   - monorepo commit;
   - upstream base commit and release tag;
   - included `LICENSE` digest;
   - Node and Pi versions used for qualification; and
   - test command receipts.
5. Reinstall by exact npm version in a fresh directory and rerun package exports
   plus downstream conformance against the registry bytes.

Only step 5 can unblock a production consumer. A local tarball, commit, tag, or
successful dry run is not a published package.

## Emergency rollback

If released bytes fail qualification or a security issue is found:

1. deprecate the affected npm version with a specific warning; do not overwrite
   or silently unpublish unless npm policy and incident severity require it;
2. make consumers select no MCP runtime, so capability reporting fails closed;
3. publish a fixed immutable version after complete qualification;
4. preserve the faulty tag and receipts for audit; and
5. notify upstream when the issue also affects upstream behavior.

Generated files, settings mutation, deep imports, and process-global secret
workarounds are never rollback paths.

## Return to upstream

After the fork is proven, replay only the generic commits onto current upstream
`main`, reference upstream issue #85 and prior PR #56, and open a focused PR.
Retire the fork only when:

1. upstream publishes the complete documented source lifecycle;
2. exact upstream registry bytes pass the unchanged conformance and Pi tests;
3. the downstream wrapper changes package selection only—no application/domain
   contract changes;
4. rollback to the last qualified fork version is proven; and
5. the fork package is deprecated with a migration target rather than deleted.
