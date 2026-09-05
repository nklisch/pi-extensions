---
release: structured-result-delivery
status: prepared
date: 2026-09-05
packages:
  - "@nklisch/pi-mcp-adapter@2.21.0-nklisch.3"
  - "@nklisch/pi-plugins@0.8.3"
  - "@nklisch/pi-enhanced@0.4.3"
items:
  - mcp-structured-result-delivery
---

# Structured MCP result delivery — prepared, not published

The adapter preserves distinct structured facts alongside native content in successful and failed model-visible results. Combined output remains bounded and recoverable. Script calls retain their own canonical results. Comparison faults and large line counts no longer silently lose facts or turn successful dispatch into failure.

## Source and package boundary

Preparation starts at `480058b` on `release/structured-result-delivery` in the isolated release worktree. Accepted implementation commits are `e63a5e7`, `89bfa5a`, and `480058b`.

The adapter changes since its published `.2` source, `d9052df46e8aae1c2a0a842e0d61ed5ef3ddbcb3`, are exactly those three commits. Changes under `packages/` since Enhanced 0.4.2's published source, `7f7a0f345039204f5cbd40946c559e7d9541de6f`, are confined to that adapter fix. No additional committed package feature is selected by this release boundary. The original checkout's dirty lockfile and untracked Ollama work are excluded and were not copied.

The adapter advances to `2.21.0-nklisch.3`. Plugin Host advances to `0.8.3` for its changed exact adapter pin. Enhanced advances to `0.4.3` for the matching adapter pin and bundled host. Enhanced retains its `^0` host range. The bundle-aware packer stages the local host workspace, so registry-byte inspection must confirm bundled host `0.8.3`.

Subagents remains `18.2.0-nklisch.1`, including its exact host pin and nested bundle. Every other workspace version remains unchanged. Do not dispatch `all`: that would select unrelated unpublished packages.

The current Plugin Host removed the historical sibling receipt and `test/runtime/published-package-provenance.test.ts`. Its current composition uses `configOverlay`, not the old source-lifecycle contract. No runtime receipt, version-sync machinery, or subagent release is required. The adapter maintenance checklist and vision now reflect that boundary. Older conventions still mention those removed mechanisms. Do not restore them or migrate the ledger for this release.

## Preparation evidence

- Registry version lists on 2026-09-05 contain none of the three candidate versions. Latest versions are adapter `.2`, host `0.8.2`, and Enhanced `0.4.2`. The repository tags endpoint returned no tags. The workflow does not create Git tags.
- Node `v24.17.0`, npm `11.18.0` refreshed metadata with `npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund` in 948 ms. All manifest versions and exact pins changed before that command. The lock diff contains only three versions and two pins.
- Preparation checks passed: `npm run validate` (13 packages), `git diff --check`, and direct manifest/lock assertions for all three candidates plus unchanged subagents. Both exact adapter pins agree, and no nested host adapter lock entry exists.
- Inherited implementation evidence at `480058b`: independent review, typecheck, 114 focused tests, root `npm run check` including 1,043 adapter tests, and packed-consumer qualification. This is not qualification of the new release metadata.
- Installed Workbench guidance is `0.20.0`, while the project stamp is `0.10.1`. Setup is advisory and outside scope. Preserve the known three validator failures and the existing completed stub until the parent reconciles this release. No unrelated outcome cleanup is authorized here.

## External intake: inspected evidence and remaining blocker

Inspected the upstream GitHub release descriptions from `v2.20.1` through `v2.32.1`, current npm metadata, the immutable `v2.32.1` tag reference, and public advisory endpoints for upstream and this monorepo.

- `pi-mcp-adapter@2.32.1` reports MIT and npm `gitHead` `10a45367e033a32026987a75d6f401e37340c86f`. The GitHub tag resolves directly to that same commit.
- The latest release fixes generated public-helper package artifacts. This release uses its own explicit builds and packed-consumer gate. No external source is integrated.
- Both public advisory endpoints returned zero entries. This does not establish the absence of private or unreported vulnerabilities.
- The inspected release descriptions include security-relevant changes: argument-scoped session approvals in `v2.26.1`/`v2.27.0` (issue #367), stale OAuth invalidation preserving another process's replacement credentials in `v2.28.0` (PR #422), and sandbox-origin changes in `v2.32.0` (issue #480).

**Before publication, the parent must disposition applicability of those security-relevant notices against maintained code.** Release metadata inspection is not source-level security qualification. This preparation does not attest uninspected upstream source, claim those fixes are integrated, or broaden the accepted adapter fix. If a notice requires code changes, return that bounded decision to the owner before publishing this candidate.

Sources: `https://github.com/nicobailon/pi-mcp-adapter/releases`, `https://api.github.com/repos/nicobailon/pi-mcp-adapter/git/ref/tags/v2.32.1`, `https://registry.npmjs.org/pi-mcp-adapter`, and each repository's `/security-advisories` API endpoint.

## Parent qualification and publication order

1. Resolve the external-intake blocker. Review this preparation diff and record the exact candidate commit.
2. Run the following gates in the clean release worktree on Node 24. Build and installation commands belong to the parent.

   ```sh
   npm ci
   npm install --prefix packages/pi-mcp-adapter/examples/interactive-visualizer --package-lock=false --ignore-scripts
   npm run build --prefix packages/pi-mcp-adapter/examples/interactive-visualizer
   npm run check
   npm run test:package --workspace @nklisch/pi-mcp-adapter
   node scripts/pack-package.mjs packages/pi-mcp-adapter --dry-run
   node scripts/pack-package.mjs packages/pi-plugins --dry-run
   node scripts/pack-package.mjs packages/pi-enhanced --dry-run
   git diff --check
   ```

   Repeat the accepted structured-result packed-consumer fixture against this candidate. Do not run `test:host-conformance`: its required `test/contract/mcp-runtime.contract.ts` no longer exists. Root checks cover current host composition, compiled imports, bundle resources, and subagent restart behavior.

3. Integrate the reviewed exact candidate into `main` without unrelated changes. Push only through the parent's authorized release process. Confirm remote main's commit before each dispatch and each workflow run's `headSha` afterward. The workflow takes only `package`, not a commit input. If main advances, stop and qualify the actual selected commit.
4. Publish the adapter first:

   ```sh
   gh workflow run publish.yml --repo nklisch/pi-extensions --ref main -f package=pi-mcp-adapter
   gh run list --repo nklisch/pi-extensions --workflow publish.yml --event workflow_dispatch --limit 5 --json databaseId,headSha,status,conclusion,url
   ```

   Wait for that exact run to succeed. Record registry receipts and qualify registry bytes before publishing consumers.
5. Publish Plugin Host, wait for success, record receipts, and verify its exact adapter pin and unchanged subagent bundle:

   ```sh
   gh workflow run publish.yml --repo nklisch/pi-extensions --ref main -f package=pi-plugins
   ```

6. Publish Enhanced last, wait for success, and qualify its registry bundle before updating local installations:

   ```sh
   gh workflow run publish.yml --repo nklisch/pi-extensions --ref main -f package=pi-enhanced
   ```

The workflow uses Node 24 with its supplied npm. Capture the actual npm version from qualification rather than assuming CI pins `11.18.0`. It cross-builds Clearance's five native targets even for a single-package dispatch, then runs the full root check. This does not publish Clearance. Use the workflow's staged native artifacts for Enhanced's supported-platform bundle. Local Linux-only packs do not prove cross-platform native coverage.

## Required publication receipts — pending

For each exact package, collect registry metadata after its successful dispatch:

```sh
npm view @nklisch/pi-mcp-adapter@2.21.0-nklisch.3 version dist gitHead --json
npm view @nklisch/pi-plugins@0.8.3 version dist gitHead --json
npm view @nklisch/pi-enhanced@0.4.3 version dist gitHead --json
npm view @nklisch/pi-mcp-adapter time --json
npm view @nklisch/pi-plugins time --json
npm view @nklisch/pi-enhanced time --json
```

Record exact publication times, tarball URLs, SHA-512 integrity values, workflow run URLs, source commit, and provenance attestations. npm currently omits `gitHead` for the previous maintained releases. Record absence honestly and bind source using workflow and provenance evidence. The included adapter LICENSE SHA-256 is `2d20dfacd9742706e564470dc77438608a1e54b0ed46959f080709389209093c`.

In fresh temporary consumers, install exact registry versions and verify root/programmatic exports, CLI, model-visible structured delivery, host overlay registration, and Enhanced's actual dependency tree. Qualify with explicit Pi `0.82.0` for comparison with accepted evidence, and separately with the intended installed Pi host before local replacement. Check that both Enhanced and its bundled host resolve adapter `.3`, the host is `0.8.3`, and subagents remains `18.2.0-nklisch.1`. Remove temporary consumers afterward. Neither a local tarball nor an npm version field is proof of publication or runtime success.

Only after those receipts exist should the parent change status to published, replace the Prepared changelog headings with publication dates, reconcile the completed outcome stub, and update local installations. The separate Krometrail live-page attachment failure is not part of this Pi fix.

## Authentication and approvals

Use trusted GitHub Actions publishing, not `npm publish --local`, local npm tokens, or new secrets. The existing workflow has `id-token: write`, no environment approval declaration, and no `registry-url` token injection. Existing package trusted-publisher registrations must still authorize this repository and `.github/workflows/publish.yml`.

No login was requested or needed for these read-only metadata lookups. If dispatch or npm's OIDC exchange fails, report the concrete permission or trusted-publisher configuration error before requesting login. The optional `maintained` dist-tag is stale and does not affect exact pins or `latest`. Updating it would require separate npm authentication and is not a release prerequisite.
