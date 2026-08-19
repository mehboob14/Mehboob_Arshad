import type { UnitOfWork } from '../../../shared/persistence/unit-of-work.js';
import type { SubscriptionRepository } from '../domain/ports.js';
import type { SubscriptionBundle } from '../domain/subscription-bundle.js';
import type { BundleRow } from './bundle-row.js';
import { BUNDLE_COLUMNS, toBundle } from './bundle-row.js';

export class PostgresSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly db: UnitOfWork) {}

  async insert(uow: UnitOfWork, bundle: SubscriptionBundle): Promise<void> {
    const state = bundle.snapshot();
    await uow.query(
      `INSERT INTO subscription_bundles
         (id, user_id, tier, billing_cycle, status, max_messages, used_messages,
          price_cents, currency, auto_renew, start_date, end_date, renewal_date, cancelled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        state.id,
        state.userId,
        state.tier,
        state.billingCycle,
        state.status,
        state.maxMessages,
        state.usedMessages,
        state.priceCents,
        state.currency,
        state.autoRenew,
        state.startDate,
        state.endDate,
        state.renewalDate,
        state.cancelledAt,
      ],
    );
  }

  async update(uow: UnitOfWork, bundle: SubscriptionBundle): Promise<void> {
    const state = bundle.snapshot();
    await uow.query(
      `UPDATE subscription_bundles
          SET status = $2, used_messages = $3, auto_renew = $4, start_date = $5,
              end_date = $6, renewal_date = $7, cancelled_at = $8
        WHERE id = $1`,
      [
        state.id,
        state.status,
        state.usedMessages,
        state.autoRenew,
        state.startDate,
        state.endDate,
        state.renewalDate,
        state.cancelledAt,
      ],
    );
  }

  async lockById(uow: UnitOfWork, bundleId: string): Promise<SubscriptionBundle | null> {
    const [row] = await uow.query<BundleRow>(
      `SELECT ${BUNDLE_COLUMNS} FROM subscription_bundles WHERE id = $1 FOR UPDATE`,
      [bundleId],
    );
    return row ? toBundle(row) : null;
  }

  async findForUser(bundleId: string, userId: string): Promise<SubscriptionBundle | null> {
    const [row] = await this.db.query<BundleRow>(
      `SELECT ${BUNDLE_COLUMNS} FROM subscription_bundles WHERE id = $1 AND user_id = $2`,
      [bundleId, userId],
    );
    return row ? toBundle(row) : null;
  }

  async listByUser(userId: string): Promise<SubscriptionBundle[]> {
    const rows = await this.db.query<BundleRow>(
      `SELECT ${BUNDLE_COLUMNS} FROM subscription_bundles
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(toBundle);
  }

  /**
   * Read without locking. The billing run does not hold a lock while it decides
   * what to do — the claim on the billing period is what makes the work
   * exclusive, and it costs nothing if this read is momentarily stale.
   */
  async findDue(at: Date, limit: number): Promise<SubscriptionBundle[]> {
    const rows = await this.db.query<BundleRow>(
      `SELECT ${BUNDLE_COLUMNS} FROM subscription_bundles
        WHERE status = 'ACTIVE' AND end_date <= $1
        ORDER BY end_date
        LIMIT $2`,
      [at, limit],
    );
    return rows.map(toBundle);
  }

  async findAwaitingPayment(before: Date, limit: number): Promise<SubscriptionBundle[]> {
    const rows = await this.db.query<BundleRow>(
      `SELECT ${BUNDLE_COLUMNS} FROM subscription_bundles
        WHERE status = 'PENDING_PAYMENT' AND created_at < $1
        ORDER BY created_at
        LIMIT $2`,
      [before, limit],
    );
    return rows.map(toBundle);
  }
}
