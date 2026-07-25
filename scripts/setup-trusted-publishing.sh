#!/usr/bin/env bash
# setup-trusted-publishing.sh — configure npm trusted publishing (OIDC) for
# every package in this monorepo against nklisch/pi-extensions +
# .github/workflows/publish.yml.
#
# Idempotent: for each package it revokes every existing trust relationship
# (stale ones point at the standalone repos from before the monorepo) and
# creates the single correct one. Safe to re-run.
#
# Prerequisites:
#   npm login   (account must own the @nklisch scope)
#
# Note: npm requires fresh 2FA for every account-management operation
# (list/create/revoke). Expect a browser or OTP prompt per package per step.
#
# New, never-published package names may be rejected by the registry. If a
# package fails with a not-found-style error, publish it once manually, then
# re-run this script — thereafter only the workflow publishes.
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

# Print the trust ids currently registered for a package, one per line.
# Warns loudly when the list call itself fails (usually a fresh-2FA wall),
# since silently assuming "no trusts" masks stale ones that block creation.
trust_ids() {
  local output status
  output=$(npm trust list "$1" --json 2>&1) && status=0 || status=$?
  if [ "$status" -ne 0 ]; then
    echo "    WARNING: trust list failed for $1 (auth?) — if create 409s, revoke manually" >&2
    return
  fi
  printf '%s' "$output" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      try {
        const start = raw.search(/[[{]/);
        const parsed = JSON.parse(raw.slice(start));
        const list = Array.isArray(parsed) ? parsed : (parsed.trusts ?? parsed.relationships ?? [parsed]);
        for (const entry of list) {
          const id = entry?.id ?? entry?.trustId ?? entry?.trust_id;
          if (id) console.log(id);
        }
      } catch { /* no trusts or unparsable output */ }
    });
  '
}

failures=()
for pkg in "${PACKAGES[@]}"; do
  echo "==> ${pkg}"

  ids=$(trust_ids "${pkg}")
  if [ -n "${ids}" ]; then
    while IFS= read -r id; do
      echo "    revoking stale trust ${id}"
      npm trust revoke "${pkg}" --id="${id}" --yes || failures+=("${pkg} (revoke ${id})")
    done <<< "${ids}"
  else
    echo "    no existing trusts"
  fi

  echo "    creating trust -> ${REPO} / ${WORKFLOW_FILE}"
  if npm trust github "${pkg}" --file "${WORKFLOW_FILE}" --repo "${REPO}" --allow-publish --yes; then
    echo "    ok"
  else
    echo "    FAILED"
    failures+=("${pkg} (create)")
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
  echo "Failures: ${failures[*]}" >&2
  exit 1
fi
