---
id: feature-all-packages-minor-release
kind: feature
status: active
tags: [release, publishing]
parent: null
blocked_by: []
related_to: []
research_refs: []
mock_refs: []
created: 2026-08-06
updated: 2026-08-06
---

# Publish the prepared repository release

Bump Pi Clearance to its next minor version and publish every prepared unpublished workspace through the trusted-publishing workflow.

## Boundary

Bump only `@nklisch/pi-clearance` from `0.1.1` to `0.2.0` and synchronize the root lockfile. Preserve every other workspace's already-prepared version, exact sibling pins, source-load receipts, package metadata, and the private root version. Publish with `package=all`; the repository publisher skips versions already present on npm and publishes each prepared unpublished version.

Commit and push the completed Clearance, subagent, MCP, and repository work already present on `main`, then dispatch `.github/workflows/publish.yml` with `package=all`. The workflow is the only publishing path because npm trusted publishing requires GitHub OIDC provenance. Verify the workflow and every target registry version before completion.

## Prepared unpublished versions

- `@nklisch/pi-clearance`: `0.2.0` after this release bump
- `@nklisch/pi-mcp-adapter`: `2.20.1-nklisch.0`
- `@nklisch/pi-plugins`: `0.3.3`
- `@nklisch/pi-subagents`: `18.1.0-nklisch.0`

Other workspace versions remain unchanged and are skipped when already published.

## Verification

Confirm the four prepared versions are unpublished, run `npm run check`, inspect packed manifests and sibling pins, validate Workbench, review the complete release diff, push `main`, observe the all-packages publish workflow to success, and verify the four exact versions through the npm registry.
