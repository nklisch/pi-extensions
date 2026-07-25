#!/usr/bin/env bash
# setup-trusted-publishing.sh — configure npm trusted publishing (OIDC) for
# every package in this monorepo against nklisch/pi-extensions +
# .github/workflows/publish.yml.
#
# Prerequisites:
#   npm login   (account must own the @nklisch scope; 2FA prompted as needed)
#
# New, never-published package names may be rejected by the registry. If a
# package fails with a not-found-style error, publish it once manually
# (npm run publish:package -- <name> with NPM_TOKEN or an interactive
# publish), then re-run this script — thereafter only the workflow publishes.
set -u

REPO="nklisch/pi-extensions"
WORKFLOW_FILE="publish.yml"
PACKAGES=(
  "@nklisch/pi-background-tasks"
  "@nklisch/pi-clearance"
  "@nklisch/pi-conveniences"
  "@nklisch/pi-enhanced"
  "@nklisch/pi-fff-compat"
  "@nklisch/pi-mcp-adapter"
  "@nklisch/pi-model-modes"
  "@nklisch/pi-plugins"
  "@nklisch/pi-subagents"
  "@nklisch/pi-zai-research"
)

failures=()
for pkg in "${PACKAGES[@]}"; do
  echo "==> npm trust github ${pkg} --file ${WORKFLOW_FILE} --repo ${REPO}"
  if npm trust github "${pkg}" --file "${WORKFLOW_FILE}" --repo "${REPO}" --allow-publish --yes; then
    echo "    ok"
  else
    echo "    FAILED"
    failures+=("${pkg}")
  fi
done

echo
echo "== Verification =="
for pkg in "${PACKAGES[@]}"; do
  echo "--- ${pkg}"
  npm trust list "${pkg}" 2>&1 | sed 's/^/    /'
done

if ((${#failures[@]} > 0)); then
  echo
  echo "Failed packages: ${failures[*]}" >&2
  exit 1
fi
