# @nklisch/pi-codex-pool

Route `openai-codex` requests across multiple OpenAI Codex OAuth accounts. The pool keeps the current account while both quota windows remain above their thresholds, then selects the account with the strongest remaining quota.

## Install

```sh
pi install npm:@nklisch/pi-codex-pool
```

Reload Pi after installing if the package was added to an already-running session.

## Quickstart

1. Add two accounts:

   ```text
   /codex-pool add work
   /codex-pool add personal
   ```

   Complete the native Codex OAuth flow for each account. Pi shows the authorization URL even when it cannot open a browser.

2. Check the active account and cached quota:

   ```text
   /codex-pool status
   ```

3. Select an account explicitly when needed:

   ```text
   /codex-pool use work
   ```

4. Continue using the normal `openai-codex/<model>` model selection. The pool preserves the provider and model identities.

The footer status looks like this:

```text
codex work · 5h 82% · 7d 64%
```

## Commands

| Command | Purpose |
| --- | --- |
| `/codex-pool status` | Show the active account and its remaining quota. |
| `/codex-pool list` | List account labels, ids, active state, and cached quota. |
| `/codex-pool add [label]` | Authenticate and add an OAuth account. Without a label, a non-sensitive generated label is used. |
| `/codex-pool use <id\|label>` | Make an account active. Exact ids and labels, or one unique label prefix, are accepted. |
| `/codex-pool remove <id\|label>` | Remove an account after confirmation. Use `--yes` in headless mode. |
| `/codex-pool refresh` | Refresh credentials and quota for every account. |
| `/codex-pool threshold <5h> <7d>` | Set minimum remaining percentages from 0 through 100. |
| `/codex-pool help` | Show command help. |

## Routing behavior

Both thresholds default to **10%**. The active account stays active while every known five-hour and weekly window is at or above those thresholds. A known crossing of either threshold, or a hard Codex quota failure, causes the next request to choose the healthiest account.

The selector ranks accounts by their greatest lower known percentage, then their greater known percentage, with stable account order as the final tie-breaker. If every known account is below threshold, it still uses the best remaining account. An unknown window alone does not trigger switching; a known low half of a partial snapshot does. If no account has a known snapshot, accounts remain usable.

A quota failure can retry on another account only before meaningful text, reasoning, or tool output. Each account is tried at most once for a request. Output that has already started, cancellation, authentication failures, network failures, and other provider errors are not retried.

## Storage and security

The authoritative state is one JSON file at `getAgentDir()/codex-pool.json`.

In a default installation this is `~/.pi/agent/codex-pool.json`; `PI_CODING_AGENT_DIR` changes the directory. The parent directory is created with mode `0700`, the state file with mode `0600`, and writes use an atomic replacement. A short cross-process lock prevents concurrent commands or token refreshes from losing updates or rotated refresh tokens.

The file contains OAuth credentials, so protect it like any other credential store. Removing an account deletes its credentials from the pool file. Removing the package does not delete the file, so uninstall preserves the remaining credentials. Delete the file yourself when you intentionally want to remove them.

Quota refresh failures retain the last successful snapshot and show unknown values when none exists. Unrecognized quota payloads remain unknown instead of being guessed, and the built-in provider can still start if the pool state or lock is unavailable. When `@nklisch/pi-conveniences` is separately installed, it supplies the exact custom-footer placement.
