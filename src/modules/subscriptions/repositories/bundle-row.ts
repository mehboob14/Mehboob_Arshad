import { SubscriptionBundle } from '../domain/subscription-bundle.js';
import type { BillingCycle, BundleStatus, Tier } from '../domain/tier.js';

export interface BundleRow {
  id: string;
  user_id: string;
  tier: Tier;
  billing_cycle: BillingCycle;
  status: BundleStatus;
  max_messages: number | null;
  used_messages: number;
  price_cents: number;
  currency: string;
  auto_renew: boolean;
  start_date: Date;
  end_date: Date;
  renewal_date: Date | null;
  cancelled_at: Date | null;
}

export const BUNDLE_COLUMNS =
  'id, user_id, tier, billing_cycle, status, max_messages, used_messages, ' +
  'price_cents, currency, auto_renew, start_date, end_date, renewal_date, cancelled_at';

export function toBundle(row: BundleRow): SubscriptionBundle {
  return SubscriptionBundle.rehydrate({
    id: row.id,
    userId: row.user_id,
    tier: row.tier,
    billingCycle: row.billing_cycle,
    status: row.status,
    maxMessages: row.max_messages,
    usedMessages: row.used_messages,
    priceCents: row.price_cents,
    currency: row.currency,
    autoRenew: row.auto_renew,
    startDate: row.start_date,
    endDate: row.end_date,
    renewalDate: row.renewal_date,
    cancelledAt: row.cancelled_at,
  });
}
