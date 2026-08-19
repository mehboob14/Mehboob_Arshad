export type Tier = 'BASIC' | 'PRO' | 'ENTERPRISE';
export type BillingCycle = 'MONTHLY' | 'YEARLY';
export type BundleStatus =
  'PENDING_PAYMENT' | 'ACTIVE' | 'PAYMENT_FAILED' | 'CANCELLED' | 'EXPIRED';

export interface TierDefinition {
  readonly tier: Tier;
  /** null encodes an unmetered tier; there is no numeric sentinel to overflow. */
  readonly maxMessages: number | null;
  readonly priceCents: Readonly<Record<BillingCycle, number>>;
}

export const TIER_CATALOG: Readonly<Record<Tier, TierDefinition>> = {
  BASIC: { tier: 'BASIC', maxMessages: 10, priceCents: { MONTHLY: 900, YEARLY: 9_000 } },
  PRO: { tier: 'PRO', maxMessages: 100, priceCents: { MONTHLY: 4_900, YEARLY: 49_000 } },
  ENTERPRISE: {
    tier: 'ENTERPRISE',
    maxMessages: null,
    priceCents: { MONTHLY: 29_900, YEARLY: 299_000 },
  },
};

export function tierDefinition(tier: Tier): TierDefinition {
  return TIER_CATALOG[tier];
}
