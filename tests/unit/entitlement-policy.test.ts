import { describe, expect, it } from 'vitest';
import { selectAllowance } from '../../src/modules/subscriptions/domain/entitlement-policy.js';
import { FreeAllowance } from '../../src/modules/subscriptions/domain/free-allowance.js';
import { SubscriptionBundle } from '../../src/modules/subscriptions/domain/subscription-bundle.js';
import type { BundleStatus, Tier } from '../../src/modules/subscriptions/domain/tier.js';
import { CalendarMonth } from '../../src/shared/domain/calendar-month.js';

const NOW = new Date('2026-08-19T10:00:00Z');
const USER = 'user-1';

function free(used: number, granted = 3): FreeAllowance {
  return new FreeAllowance(USER, CalendarMonth.from(NOW), granted, used);
}

function bundle(overrides: {
  id: string;
  maxMessages: number | null;
  usedMessages?: number;
  endDate?: string;
  status?: BundleStatus;
  startDate?: string;
  tier?: Tier;
}): SubscriptionBundle {
  return SubscriptionBundle.rehydrate({
    id: overrides.id,
    userId: USER,
    tier: overrides.tier ?? (overrides.maxMessages === null ? 'ENTERPRISE' : 'BASIC'),
    billingCycle: 'MONTHLY',
    status: overrides.status ?? 'ACTIVE',
    maxMessages: overrides.maxMessages,
    usedMessages: overrides.usedMessages ?? 0,
    priceCents: 900,
    currency: 'USD',
    autoRenew: true,
    startDate: new Date(overrides.startDate ?? '2026-08-01T00:00:00Z'),
    endDate: new Date(overrides.endDate ?? '2026-09-01T00:00:00Z'),
    renewalDate: null,
    cancelledAt: null,
  });
}

describe('selectAllowance', () => {
  it('spends the free grant before any paid balance', () => {
    const granted = selectAllowance(
      { freeAllowance: free(0), bundles: [bundle({ id: 'b1', maxMessages: 10 })] },
      NOW,
    );

    expect(granted?.charge).toEqual({ source: 'FREE_TIER', period: '2026-08' });
    expect(granted?.remaining).toBe(2);
  });

  it('falls through to a bundle once the free grant is spent', () => {
    const granted = selectAllowance(
      { freeAllowance: free(3), bundles: [bundle({ id: 'b1', maxMessages: 10, usedMessages: 4 })] },
      NOW,
    );

    expect(granted?.charge).toEqual({ source: 'BUNDLE', bundleId: 'b1' });
    expect(granted?.remaining).toBe(5);
  });

  it('draws from the bundle with the greatest remaining balance', () => {
    const granted = selectAllowance(
      {
        freeAllowance: free(3),
        bundles: [
          bundle({ id: 'small', maxMessages: 10, usedMessages: 8 }),
          bundle({ id: 'large', maxMessages: 100, usedMessages: 40 }),
        ],
      },
      NOW,
    );

    expect(granted?.charge).toEqual({ source: 'BUNDLE', bundleId: 'large' });
  });

  it('breaks a tie on remaining balance by spending the credit that expires first', () => {
    const granted = selectAllowance(
      {
        freeAllowance: free(3),
        bundles: [
          bundle({ id: 'later', maxMessages: 10, endDate: '2026-12-01T00:00:00Z' }),
          bundle({ id: 'sooner', maxMessages: 10, endDate: '2026-09-01T00:00:00Z' }),
        ],
      },
      NOW,
    );

    expect(granted?.charge).toEqual({ source: 'BUNDLE', bundleId: 'sooner' });
  });

  it('keeps an unlimited bundle in reserve while metered credit is spendable', () => {
    const granted = selectAllowance(
      {
        freeAllowance: free(3),
        bundles: [
          bundle({ id: 'enterprise', maxMessages: null }),
          bundle({ id: 'basic', maxMessages: 10, usedMessages: 9 }),
        ],
      },
      NOW,
    );

    expect(granted?.charge).toEqual({ source: 'BUNDLE', bundleId: 'basic' });
    expect(granted?.remaining).toBe(0);
  });

  it('uses the unlimited bundle once no metered credit is left', () => {
    const granted = selectAllowance(
      {
        freeAllowance: free(3),
        bundles: [
          bundle({ id: 'enterprise', maxMessages: null }),
          bundle({ id: 'basic', maxMessages: 10, usedMessages: 10 }),
        ],
      },
      NOW,
    );

    expect(granted?.charge).toEqual({ source: 'BUNDLE', bundleId: 'enterprise' });
    expect(granted?.remaining).toBeNull();
  });

  it('ignores bundles that are outside their billing window or not active', () => {
    const granted = selectAllowance(
      {
        freeAllowance: free(3),
        bundles: [
          bundle({ id: 'expired', maxMessages: 10, endDate: '2026-08-01T00:00:00Z' }),
          bundle({ id: 'future', maxMessages: 10, startDate: '2026-12-01T00:00:00Z' }),
          bundle({ id: 'cancelled', maxMessages: 10, status: 'CANCELLED' }),
          bundle({ id: 'unpaid', maxMessages: 10, status: 'PAYMENT_FAILED' }),
        ],
      },
      NOW,
    );

    expect(granted).toBeNull();
  });

  it('reports exhaustion rather than choosing an overdrawn bundle', () => {
    const granted = selectAllowance(
      {
        freeAllowance: free(3),
        bundles: [bundle({ id: 'spent', maxMessages: 10, usedMessages: 10 })],
      },
      NOW,
    );

    expect(granted).toBeNull();
  });
});
