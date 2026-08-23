# Maintained product policy

`@nklisch/pi-mcp-adapter` is an independently maintained MIT-licensed MCP client for Pi. It descends from [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter), retains upstream authorship and license history, and learns from that project and other MCP clients. External projects are prior art and compatibility inputs. They are not runtime dependencies, release pins, or retirement targets.

The package lives in the `nklisch/pi-extensions` monorepo under `packages/pi-mcp-adapter`. Pre-monorepo history remains in the `nklisch/pi-mcp-adapter` repository.

## Provenance

- Material external release integrated through: `pi-mcp-adapter@2.20.1`
- Release commit and tag: `1dbdef96f674410ac37067de70f10a3de3d48d98` (`v2.20.1`)
- Reviewed post-release fixes integrated through: `08fe82be1d55036d3960c4bb3fa77ed8707f2bca`
- Common ancestry used for three-way integration: `82724dccc13a49310530898f922bafff12b7f3fe` (`v2.11.0`)
- npm package: `@nklisch/pi-mcp-adapter`, published through `2.21.0-nklisch.1`
- Security reports: the private GitHub security-advisory channel for the maintained package
- License: MIT

The package version or a local commit is not publication evidence. A release exists only after the immutable npm and GitHub receipts in the publication checklist are recorded.

Update this provenance when an external source range is integrated. Preserve the exact source commits, license, imported authorship, and any locally rewritten behavior that affects later maintenance.

## Ownership boundary

The package owns:

1. standalone MCP configuration, management, transports, authentication, discovery, prompts, approvals, output handling, and MCP Apps;
2. the typed `./programmatic` package export;
3. exact source registration, compare-and-replace, removal, inspection, and capability reporting;
4. source-qualified process, tool, cache, status, credential, and UI identity where those capabilities are available;
5. callback-scoped launch values, cancellation, and runtime leases;
6. compact agent discovery, batched exact schema loading, and schema-on-error guidance; and
7. tests and documentation that prove these contracts.

Generic MCP behavior uses one implementation. Do not create parallel SDK, transport, authentication, output, or UI stacks for standalone and programmatic operation. Add a narrow source-ownership seam to the shared implementation when programmatic operation needs different identity, launch-value, fallback, or cleanup behavior.

The adapter does not own Plugin Host policy, installation state, marketplace trust, immutable plugin revisions, or generated projections. It must not mutate Plugin Host state, write generated Plugin Host configuration, inject secrets through process-global state, or retain expanded launch values beyond connection creation.

A feature that is safe in standalone mode is not automatically available to programmatic sources. Expose it only after exact source ownership, cancellation, redaction, replacement, removal, and lease behavior are qualified. Capability reporting stays false until that work is complete.

## External change intake

Evaluate external releases and security notices before every package publication and at least monthly. For a useful source range:

1. fetch the immutable commits and tags;
2. verify the published package version, npm `gitHead`, source tag, commit, and license independently;
3. attest the inspected source and record the integration decision;
4. integrate through the real common ancestry when available, or reimplement behavior when that produces a clearer maintained design;
5. preserve this package's public contracts and stronger local behavior when resolving conflicts; and
6. qualify the complete result as this package's code.

A common-base merge is an implementation technique, not an ongoing tracking promise. Do not add an external package dependency or source pin merely to delegate maintenance ownership.

Critical credential, authentication, sandbox, and transport fixes are evaluated immediately. Credential binding includes the exact endpoint authority and path. A higher-precedence configuration that changes an endpoint must not inherit authorization intended for the previous endpoint.

## Qualification commands

Run on Node 24 from a clean monorepo checkout:

```bash
npm install
npm install --prefix packages/pi-mcp-adapter/examples/interactive-visualizer --package-lock=false --ignore-scripts
npm run build --prefix packages/pi-mcp-adapter/examples/interactive-visualizer
npm test --workspace @nklisch/pi-mcp-adapter
npm run test:package --workspace @nklisch/pi-mcp-adapter
npm pack --dry-run --workspace @nklisch/pi-mcp-adapter
npm run check
```

The visualizer build produces ignored fixtures required by the package suite. Then install the exact local tarball into an isolated consumer and run Plugin Host's adapter-neutral MCP contract through the packed `@nklisch/pi-mcp-adapter/programmatic` export.

Required evidence includes:

- ordinary standalone extension and CLI behavior;
- no-source standalone parity;
- initial programmatic sources visible before Pi tool registration;
- disabled file, import, and standalone-cache discovery in Plugin Host composition;
- exact identity isolation through process, tool, cache, status, credential, and UI paths that are enabled;
- atomic stale or failed replacement rollback and exact idempotent removal;
- pre-abort and in-flight cancellation;
- launch-value disposal and runtime-lease release on every outcome;
- redaction canaries absent from status, diagnostics, logs, caches, and packed metadata;
- exact Streamable HTTP for programmatic sources without legacy-SSE fallback;
- conservative legacy and negotiated modern protocol fixtures for standalone operation;
- secure credential-store failure without plaintext fallback;
- no eager programmatic server, script worker, OAuth flow, or UI listener;
- bounded model output, transcript rendering, and MCP Apps context handoff;
- package exports that deny unsupported deep imports;
- native dependency installation in the packed-consumer environment;
- the MIT license and attributed vendored assets in the tarball; and
- unchanged downstream Plugin Host ordering, isolation, and lifecycle conformance.

## Publication checklist

Publication is an operator action through the monorepo's trusted-publishing workflow. Never infer publication receipts from a local build.

1. Choose a final immutable version with `npm version --workspace @nklisch/pi-mcp-adapter --no-git-tag-version`.
2. Update `pi-plugins`' exact sibling dependency, receipt, tests, and foundation version in the same delivery boundary.
3. Rerun all qualification against the exact release commit.
4. Dispatch the **Publish Pi extension** workflow for `pi-mcp-adapter`.
5. Record together:
   - npm version and `sha512` integrity;
   - npm tarball URL and registry publication time;
   - npm `gitHead`;
   - monorepo commit;
   - material external source commits and release tags;
   - included `LICENSE` digest;
   - Node and Pi versions used for qualification; and
   - test command receipts.
6. Reinstall the exact npm version in a fresh directory and rerun package exports plus downstream conformance against the registry bytes.

Only the final registry-byte qualification can unblock a production consumer. A local tarball, commit, tag, or successful dry run is not a published package.

## Emergency recovery

If released bytes fail qualification or contain a security defect:

1. deprecate the affected npm version with a specific warning; do not overwrite immutable versions;
2. make Plugin Host select no MCP runtime when qualification fails, so dependent capability reporting fails closed;
3. publish a corrected immutable version after complete qualification;
4. preserve the faulty tag and receipts for investigation; and
5. notify another project when the defect also affects its implementation.

Generated configuration, settings mutation, deep imports, plaintext secret fallback, and process-global secret workarounds are never recovery paths.

## Collaboration

Contribute generic fixes or source-lifecycle ideas to other MCP projects when useful, without making this package's roadmap contingent on acceptance. External implementations may later adopt equivalent behavior; that does not change this package's ownership or support commitment.
