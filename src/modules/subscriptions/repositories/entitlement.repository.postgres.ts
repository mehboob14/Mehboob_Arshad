import type { AllowanceCharge } from '../../../shared/domain/allowance.js';
import { CalendarMonth } from '../../../shared/domain/calendar-month.js';
import type { UnitOfWork } from '../../../shared/persistence/unit-of-work.js';
import type { EntitlementSnapshot } from '../domain/entitlement-policy.js';
import { FreeAllowance } from '../domain/free-allowance.js';
import type { EntitlementRepository, EntitlementSummary } from '../domain/ports.js';
import type { BundleRow } from './bundle-row.js';
import { BUNDLE_COLUMNS, toBundle } from './bundle-row.js';

interface FreeRow {
  granted: number;
  used: number;
}

export class PostgresEntitlementRepository implements EntitlementRepository {
  constructor(private readonly db: UnitOfWork) {}

  /**
   * Locks are always taken in the same order — the free period row first, then
   * bundles by primary key — so two concurrent requests for one user queue
   * behind each other instead of deadlocking on a crossed acquisition order.
   */
  async loadForUpdate(
    uow: UnitOfWork,
    userId: string,
    at: Date,
    freeGrant: number,
  ): Promise<EntitlementSnapshot> {
    const month = CalendarMonth.from(at);

    // The row for a month is created on first use rather than by a scheduled
    // job, so "reset on the 1st" has no moving parts that can be missed, run
    // twice, or run late.
    await uow.query(
      `INSERT INTO free_allowance_periods (user_id, period, granted)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, period) DO NOTHING`,
      [userId, month.key, freeGrant],
    );

    const [free] = await uow.query<FreeRow>(
      `SELECT granted, used
         FROM free_allowance_periods
        WHERE user_id = $1 AND period = $2
        FOR UPDATE`,
      [userId, month.key],
    );

    const bundles = await uow.query<BundleRow>(
      `SELECT ${BUNDLE_COLUMNS}
         FROM subscription_bundles
        WHERE user_id = $1 AND status = 'ACTIVE' AND start_date <= $2 AND end_date > $2
        ORDER BY id
        FOR UPDATE`,
      [userId, at],
    );

    return {
      freeAllowance: new FreeAllowance(userId, month, free?.granted ?? freeGrant, free?.used ?? 0),
      bundles: bundles.map(toBundle),
    };
  }

  async applyCharge(uow: UnitOfWork, userId: string, charge: AllowanceCharge): Promise<boolean> {
    if (charge.source === 'FREE_TIER') {
      const rows = await uow.query(
        `UPDATE free_allowance_periods
            SET used = used + 1
          WHERE user_id = $1 AND period = $2 AND used < granted
          RETURNING used`,
        [userId, charge.period],
      );
      return rows.length === 1;
    }

    const rows = await uow.query(
      `UPDATE subscription_bundles
          SET used_messages = used_messages + 1
        WHERE id = $1 AND user_id = $2
          AND (max_messages IS NULL OR used_messages < max_messages)
        RETURNING used_messages`,
      [charge.bundleId, userId],
    );
    return rows.length === 1;
  }

  async reverseCharge(uow: UnitOfWork, userId: string, charge: AllowanceCharge): Promise<void> {
    if (charge.source === 'FREE_TIER') {
      await uow.query(
        `UPDATE free_allowance_periods
            SET used = used - 1
          WHERE user_id = $1 AND period = $2 AND used > 0`,
        [userId, charge.period],
      );
      return;
    }
    await uow.query(
      `UPDATE subscription_bundles
          SET used_messages = used_messages - 1
        WHERE id = $1 AND user_id = $2 AND used_messages > 0`,
      [charge.bundleId, userId],
    );
  }

  async summarise(userId: string, at: Date, freeGrant: number): Promise<EntitlementSummary> {
    const month = CalendarMonth.from(at);

    const [freeRow] = await this.db.query<FreeRow>(
      `SELECT granted, used FROM free_allowance_periods WHERE user_id = $1 AND period = $2`,
      [userId, month.key],
    );
    const free = new FreeAllowance(
      userId,
      month,
      freeRow?.granted ?? freeGrant,
      freeRow?.used ?? 0,
    );

    const rows = await this.db.query<BundleRow>(
      `SELECT ${BUNDLE_COLUMNS}
         FROM subscription_bundles
        WHERE user_id = $1 AND status = 'ACTIVE' AND start_date <= $2 AND end_date > $2
        ORDER BY end_date`,
      [userId, at],
    );
    const bundles = rows.map(toBundle);
    const unlimited = bundles.some((bundle) => bundle.isUnlimited);
    const metered = bundles.reduce((sum, bundle) => sum + (bundle.remaining ?? 0), 0);

    return {
      free: {
        granted: free.granted,
        used: free.used,
        remaining: free.remaining,
        resetsAt: free.resetsAt.toISOString(),
      },
      bundles: bundles.map((bundle) => {
        const state = bundle.snapshot();
        return {
          id: state.id,
          tier: state.tier,
          billingCycle: state.billingCycle,
          maxMessages: state.maxMessages,
          usedMessages: state.usedMessages,
          remaining: bundle.remaining,
          endDate: state.endDate.toISOString(),
          autoRenew: state.autoRenew,
        };
      }),
      totalRemaining: unlimited ? null : free.remaining + metered,
    };
  }
}
