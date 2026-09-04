import type { AccountRecord, PoolState } from "./types.ts";

function belowThreshold(account: AccountRecord, state: PoolState): boolean {
  const quota = account.quota;
  if (!quota) return false;
  // An unknown window cannot trigger a switch, but any known window below
  // threshold can. This prevents a known exhausted window from being hidden
  // by a still-unreported window.
  return (quota.fiveHour !== null && quota.fiveHour < state.thresholds.fiveHour)
    || (quota.weekly !== null && quota.weekly < state.thresholds.weekly);
}

function rank(account: AccountRecord): [number, number] {
  const values = [account.quota?.fiveHour ?? null, account.quota?.weekly ?? null].filter(
    (value): value is number => value !== null,
  );
  if (values.length === 0) return [-1, -1];
  return [Math.min(...values), Math.max(...values)];
}

/** Select the sticky active account, or the healthiest usable account when switching is required. */
export function selectAccount(
  state: PoolState,
  excludedIds: ReadonlySet<string> = new Set(),
): AccountRecord | undefined {
  const usable = state.accounts.filter((account) => !account.quotaFailed && !excludedIds.has(account.id));
  if (usable.length === 0) return undefined;
  const active = usable.find((account) => account.id === state.activeAccountId);
  if (active && !belowThreshold(active, state)) return active;

  let best = usable[0];
  for (const candidate of usable.slice(1)) {
    const bestRank = rank(best);
    const candidateRank = rank(candidate);
    if (candidateRank[0] > bestRank[0]
      || (candidateRank[0] === bestRank[0] && candidateRank[1] > bestRank[1])
    ) {
      best = candidate;
    }
  }
  return best;
}
