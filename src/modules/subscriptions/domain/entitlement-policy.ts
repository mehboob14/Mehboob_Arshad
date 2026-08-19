import type { GrantedAllowance } from '../../../shared/domain/allowance.js';
import type { FreeAllowance } from './free-allowance.js';
import type { SubscriptionBundle } from './subscription-bundle.js';

export interface EntitlementSnapshot {
  readonly freeAllowance: FreeAllowance;
  readonly bundles: readonly SubscriptionBundle[];
}

/**
 * Decides which allowance pays for one message. Pure by design: it is the rule
 * the business cares about, so it is expressed without a database, a clock
 * lookup or an HTTP layer, and is exhaustively unit-testable.
 *
 * Order of preference, and why:
 *
 *  1. The free grant. It costs the user nothing, so no paid balance should ever
 *     be spent while free messages remain.
 *
 *  2. Metered bundles, greatest remaining balance first. This is the reading of
 *     "deduct from the bundle with the latest remaining quota" that leaves the
 *     user with the most usable balances: draining the largest pot keeps the
 *     smaller ones spendable rather than stranding them. Ties break on the
 *     earliest end date, so credit that is about to expire is spent first.
 *
 *  3. Unmetered (Enterprise) bundles last. A message drawn from an unlimited
 *     bundle costs the user nothing extra, whereas prepaid metered credit
 *     expires unused. Spending the perishable balance first is strictly better
 *     for the user, so unlimited acts as the fallback rather than the default.
 */
export function selectAllowance(snapshot: EntitlementSnapshot, at: Date): GrantedAllowance | null {
  const { freeAllowance } = snapshot;
  if (freeAllowance.hasCapacity) {
    return {
      charge: { source: 'FREE_TIER', period: freeAllowance.month.key },
      remaining: freeAllowance.remaining - 1,
    };
  }

  const serving = snapshot.bundles.filter((bundle) => bundle.canServeMessageAt(at));
  const metered = serving.filter((bundle) => !bundle.isUnlimited).sort(byPreference);
  const chosen = metered[0] ?? serving.find((bundle) => bundle.isUnlimited);
  if (!chosen) return null;

  return {
    charge: { source: 'BUNDLE', bundleId: chosen.id },
    remaining: chosen.remaining === null ? null : chosen.remaining - 1,
  };
}

function byPreference(a: SubscriptionBundle, b: SubscriptionBundle): number {
  const balance = (b.remaining ?? 0) - (a.remaining ?? 0);
  if (balance !== 0) return balance;
  const expiry = a.endDate.getTime() - b.endDate.getTime();
  if (expiry !== 0) return expiry;
  return a.id.localeCompare(b.id);
}
