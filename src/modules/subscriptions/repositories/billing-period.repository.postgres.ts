import type { UnitOfWork } from '../../../shared/persistence/unit-of-work.js';
import type { BillingPeriod, NewBillingPeriod } from '../domain/billing-period.js';
import type { BillingPeriodRepository } from '../domain/ports.js';

interface PeriodRow {
  id: string;
  bundle_id: string;
  period_start: Date;
  period_end: Date;
  price_cents: number;
  currency: string;
  status: BillingPeriod['status'];
  payment_reference: string | null;
  decline_reason: string | null;
  messages_used: number;
  created_at: Date;
  settled_at: Date | null;
}

const COLUMNS =
  'id, bundle_id, period_start, period_end, price_cents, currency, status, ' +
  'payment_reference, decline_reason, messages_used, created_at, settled_at';

function toPeriod(row: PeriodRow): BillingPeriod {
  return {
    id: row.id,
    bundleId: row.bundle_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    priceCents: row.price_cents,
    currency: row.currency,
    status: row.status,
    paymentReference: row.payment_reference,
    declineReason: row.decline_reason,
    messagesUsed: row.messages_used,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

export class PostgresBillingPeriodRepository implements BillingPeriodRepository {
  constructor(private readonly db: UnitOfWork) {}

  /**
   * The money equivalent of claiming an idempotency key. The row is inserted —
   * and committed — before the gateway is called, so a concurrent or retried
   * billing run finds the claim taken and does not charge again. The UNIQUE
   * constraint on (bundle_id, period_start) is what makes that decision, and it
   * makes it atomically.
   */
  async open(uow: UnitOfWork, period: NewBillingPeriod): Promise<boolean> {
    const rows = await uow.query<{ id: string }>(
      `INSERT INTO subscription_billing_periods
         (bundle_id, period_start, period_end, price_cents, currency, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING')
       ON CONFLICT ON CONSTRAINT billing_period_once_per_start DO NOTHING
       RETURNING id`,
      [period.bundleId, period.periodStart, period.periodEnd, period.priceCents, period.currency],
    );
    return rows.length === 1;
  }

  async find(uow: UnitOfWork, bundleId: string, periodStart: Date): Promise<BillingPeriod | null> {
    const [row] = await uow.query<PeriodRow>(
      `SELECT ${COLUMNS} FROM subscription_billing_periods
        WHERE bundle_id = $1 AND period_start = $2`,
      [bundleId, periodStart],
    );
    return row ? toPeriod(row) : null;
  }

  async settle(
    uow: UnitOfWork,
    bundleId: string,
    periodStart: Date,
    outcome:
      { status: 'PAID'; paymentReference: string } | { status: 'FAILED'; declineReason: string },
    at: Date,
  ): Promise<void> {
    // Only a PENDING claim can be settled, so a duplicate settlement is a no-op
    // rather than an overwrite of the recorded outcome.
    await uow.query(
      `UPDATE subscription_billing_periods
          SET status = $3, payment_reference = $4, decline_reason = $5, settled_at = $6
        WHERE bundle_id = $1 AND period_start = $2 AND status = 'PENDING'`,
      [
        bundleId,
        periodStart,
        outcome.status,
        outcome.status === 'PAID' ? outcome.paymentReference : null,
        outcome.status === 'FAILED' ? outcome.declineReason : null,
        at,
      ],
    );
  }

  async recordUsage(
    uow: UnitOfWork,
    bundleId: string,
    periodEnd: Date,
    messagesUsed: number,
  ): Promise<void> {
    await uow.query(
      `UPDATE subscription_billing_periods
          SET messages_used = $3
        WHERE bundle_id = $1 AND period_end = $2`,
      [bundleId, periodEnd, messagesUsed],
    );
  }

  async listByBundle(bundleId: string): Promise<BillingPeriod[]> {
    const rows = await this.db.query<PeriodRow>(
      `SELECT ${COLUMNS} FROM subscription_billing_periods
        WHERE bundle_id = $1
        ORDER BY period_start DESC`,
      [bundleId],
    );
    return rows.map(toPeriod);
  }
}
