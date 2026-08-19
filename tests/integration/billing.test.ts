import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  PaymentGateway,
  PaymentRequest,
  PaymentResult,
} from '../../src/modules/subscriptions/domain/payment.js';
import type { SubscriptionRepository } from '../../src/modules/subscriptions/domain/ports.js';
import { PostgresBillingPeriodRepository } from '../../src/modules/subscriptions/repositories/billing-period.repository.postgres.js';
import { PostgresSubscriptionRepository } from '../../src/modules/subscriptions/repositories/subscription.repository.postgres.js';
import { BillingService } from '../../src/modules/subscriptions/services/billing.service.js';
import { FixedClock } from '../../src/shared/domain/clock.js';
import { Harness, RecordingGateway } from './harness.js';

const BASE = new Date('2026-08-19T10:00:00Z');
const PERIOD_END = new Date('2026-09-19T10:00:00Z');
const AFTER_PERIOD = new Date('2026-09-19T10:00:01Z');

// No free messages, so every message provably comes out of the bundle.
const CONFIG = { AI_LATENCY_MIN_MS: 0, AI_LATENCY_MAX_MS: 0, FREE_MESSAGES_PER_MONTH: 0 };

/** Succeeds, but lets the test mutate the subscription while the charge is in flight. */
class InterferingGateway implements PaymentGateway {
  readonly charges: PaymentRequest[] = [];
  duringCharge: () => Promise<void> = () => Promise.resolve();

  async charge(request: PaymentRequest): Promise<PaymentResult> {
    this.charges.push(request);
    await this.duringCharge();
    return { outcome: 'SUCCEEDED', reference: request.reference };
  }
}

interface RunReport {
  renewed: string[];
  declined: string[];
  closed: string[];
  needsReconciliation: string[];
}

describe('billing run', () => {
  let harness: Harness;
  let gateway: RecordingGateway;
  let clock: FixedClock;

  beforeEach(async () => {
    gateway = new RecordingGateway();
    clock = new FixedClock(BASE);
    harness = await Harness.start({ config: CONFIG, clock, paymentGateway: gateway });
  });

  afterEach(async () => {
    await harness.stop();
  });

  async function bundleDueForRenewal(options: { autoRenew?: boolean } = {}): Promise<{
    userId: string;
    bundleId: string;
  }> {
    const userId = await harness.createUser();
    const bundleId = await harness.giveBundle(userId, {
      tier: 'BASIC',
      startDate: BASE,
      endDate: PERIOD_END,
      autoRenew: options.autoRenew ?? true,
    });
    return { userId, bundleId };
  }

  it('renews, resets the allowance, and keeps the closed period as history', async () => {
    const { userId, bundleId } = await bundleDueForRenewal();
    for (let i = 0; i < 2; i++) await harness.ask({ userId, question: `q${i}` });
    expect(await harness.bundleUsage(bundleId)).toBe(2);

    clock.travelTo(AFTER_PERIOD);
    const report = (await harness.runBilling()).body as unknown as RunReport;

    expect(report.renewed).toContain(bundleId);
    expect(gateway.charges).toHaveLength(1);

    const bundle = await harness.bundle(bundleId);
    expect(bundle.status).toBe('ACTIVE');
    expect(bundle.used_messages).toBe(0);
    expect(bundle.start_date.toISOString()).toBe('2026-09-19T10:00:00.000Z');
    expect(bundle.end_date.toISOString()).toBe('2026-10-19T10:00:00.000Z');

    const periods = await harness.billingPeriods(bundleId);
    expect(periods).toHaveLength(2);
    // The closed period keeps what was spent in it, even though the counter reset.
    expect(periods[0]?.messages_used).toBe(2);
    expect(periods[1]?.status).toBe('PAID');

    // The renewed allowance is spendable.
    expect((await harness.ask({ userId, question: 'new period' })).status).toBe(201);
  });

  it('stops service when the renewal payment is declined', async () => {
    const { userId, bundleId } = await bundleDueForRenewal();
    gateway.result = 'DECLINED';

    clock.travelTo(AFTER_PERIOD);
    const report = (await harness.runBilling()).body as unknown as RunReport;

    expect(report.declined).toContain(bundleId);

    const bundle = await harness.bundle(bundleId);
    expect(bundle.status).toBe('PAYMENT_FAILED');
    expect(bundle.auto_renew).toBe(false);
    expect((await harness.billingPeriods(bundleId))[1]?.status).toBe('FAILED');

    expect((await harness.ask({ userId, question: 'no longer funded' })).status).toBe(402);
  });

  it('charges once when the run is repeated', async () => {
    const { bundleId } = await bundleDueForRenewal();

    clock.travelTo(AFTER_PERIOD);
    await harness.runBilling();
    await harness.runBilling();

    expect(gateway.charges).toHaveLength(1);
    expect(await harness.billingPeriods(bundleId)).toHaveLength(2);
  });

  it('charges once when two runs execute concurrently', async () => {
    const { bundleId } = await bundleDueForRenewal();

    clock.travelTo(AFTER_PERIOD);
    await Promise.all([harness.runBilling(), harness.runBilling(), harness.runBilling()]);

    expect(gateway.charges).toHaveLength(1);
    expect((await harness.bundle(bundleId)).status).toBe('ACTIVE');
    expect(await harness.billingPeriods(bundleId)).toHaveLength(2);
  });

  it('expires a subscription that was never set to renew, without charging', async () => {
    const { bundleId } = await bundleDueForRenewal({ autoRenew: false });

    clock.travelTo(AFTER_PERIOD);
    const report = (await harness.runBilling()).body as unknown as RunReport;

    expect(report.closed).toContain(bundleId);
    expect(gateway.charges).toHaveLength(0);
    expect((await harness.bundle(bundleId)).status).toBe('EXPIRED');
  });

  it('closes a cancelled subscription as CANCELLED and preserves its usage', async () => {
    const { userId, bundleId } = await bundleDueForRenewal();
    await harness.ask({ userId, question: 'used before cancelling' });
    await harness.request('POST', `/api/v1/subscriptions/${bundleId}/cancel`, { userId });

    clock.travelTo(AFTER_PERIOD);
    const report = (await harness.runBilling()).body as unknown as RunReport;

    expect(report.closed).toContain(bundleId);
    expect(gateway.charges).toHaveLength(0);

    const bundle = await harness.bundle(bundleId);
    expect(bundle.status).toBe('CANCELLED');
    expect(bundle.cancelled_at).not.toBeNull();

    const periods = await harness.billingPeriods(bundleId);
    expect(periods).toHaveLength(1);
    expect(periods[0]?.messages_used).toBe(1);
    expect(await harness.messageCount(userId)).toBe(1);
  });

  it('reports a charge with an unknown outcome instead of retrying it', async () => {
    const { bundleId } = await bundleDueForRenewal();
    gateway.result = 'THROW';

    clock.travelTo(AFTER_PERIOD);
    const first = (await harness.runBilling()).body as unknown as RunReport;
    expect(first.needsReconciliation).toContain(bundleId);

    // A later run must not charge again: the outcome of the first attempt is
    // still unknown, and the claim on that period is still held.
    gateway.result = 'SUCCEEDED';
    const second = (await harness.runBilling()).body as unknown as RunReport;

    expect(second.needsReconciliation).toContain(bundleId);
    expect(second.renewed).toHaveLength(0);
    expect(gateway.charges).toHaveLength(1);
    expect((await harness.bundle(bundleId)).status).toBe('ACTIVE');
  });

  it('snapshots usage when the period was closed by a database-generated timestamp', async () => {
    // These timestamps come from the database rather than the application
    // clock. Before the columns were pinned to millisecond precision they
    // carried microseconds, which a JS Date silently truncated - so the usage
    // snapshot matched no row and the closing balance was lost.
    const live = await Harness.start({ config: CONFIG });
    try {
      const userId = await live.createUser();
      const rows = await live.container.database.query<{ id: string }>(
        `INSERT INTO subscription_bundles
           (user_id, tier, billing_cycle, status, max_messages, used_messages,
            price_cents, auto_renew, start_date, end_date, renewal_date)
         VALUES ($1, 'BASIC', 'MONTHLY', 'ACTIVE', 10, 4, 900, TRUE,
                 now() - interval '30 days', now() - interval '1 minute', now() - interval '1 minute')
         RETURNING id`,
        [userId],
      );
      const bundleId = rows[0]?.id;
      if (!bundleId) throw new Error('failed to insert the bundle');

      await live.container.database.query(
        `INSERT INTO subscription_billing_periods
           (bundle_id, period_start, period_end, price_cents, status, settled_at)
         SELECT id, start_date, end_date, price_cents, 'PAID', now()
           FROM subscription_bundles WHERE id = $1`,
        [bundleId],
      );

      const report = await live.container.billing.run();

      expect(report.renewed).toContain(bundleId);
      expect(await live.bundleUsage(bundleId)).toBe(0);
      // The closing period kept what was spent in it.
      expect((await live.billingPeriods(bundleId))[0]?.messages_used).toBe(4);
    } finally {
      await live.stop();
    }
  });

  it('reports a charge for a period the subscription has since left', async () => {
    // The subscription is closed while the charge is in flight. The money moved,
    // so it must be recorded and surfaced - previously the guard returned early,
    // leaving the period PENDING with no reference, reachable by no recovery
    // path, and absent from every report.
    const gateway = new InterferingGateway();
    const live = await Harness.start({ config: CONFIG, clock, paymentGateway: gateway });
    try {
      const userId = await live.createUser();
      const bundleId = await live.giveBundle(userId, {
        tier: 'BASIC',
        startDate: BASE,
        endDate: PERIOD_END,
      });
      clock.travelTo(AFTER_PERIOD);

      gateway.duringCharge = async () => {
        await live.container.database.query(
          `UPDATE subscription_bundles
              SET status = 'CANCELLED', cancelled_at = $2, auto_renew = FALSE
            WHERE id = $1`,
          [bundleId, AFTER_PERIOD],
        );
      };

      const report = await live.container.billing.run();

      expect(gateway.charges).toHaveLength(1);
      expect(report.needsReconciliation).toContain(bundleId);
      expect(report.renewed).toHaveLength(0);

      const [, settled] = await live.container.database.query<{
        status: string;
        payment_reference: string | null;
      }>(
        `SELECT status, payment_reference FROM subscription_billing_periods
          WHERE bundle_id = $1 ORDER BY period_start`,
        [bundleId],
      );
      // The charge is on the record, not silently lost.
      expect(settled?.status).toBe('PAID');
      expect(settled?.payment_reference).toBeTruthy();
    } finally {
      await live.stop();
    }
  });

  it('never advances through a period it did not claim and charge', async () => {
    // Two cycles overdue - the scheduler was down. One runner reads the
    // subscription and is then overtaken: by the time it acts, another runner
    // has already claimed, charged and rolled that period. Reading the settled
    // outcome and advancing again would move the subscription through a period
    // with no billing row and no charge, so the guard checks that the
    // subscription is still on the boundary this run claimed, not merely that
    // it is overdue.
    const gw = new RecordingGateway();
    const live = await Harness.start({ config: CONFIG, clock, paymentGateway: gw });
    try {
      const userId = await live.createUser();
      const bundleId = await live.giveBundle(userId, {
        tier: 'BASIC',
        startDate: new Date('2026-05-19T10:00:00Z'),
        endDate: new Date('2026-06-19T10:00:00Z'),
      });
      clock.travelTo(BASE);

      const fresh = new PostgresSubscriptionRepository(live.container.database);
      const periods = new PostgresBillingPeriodRepository(live.container.database);
      let overtaken!: () => void;
      const held = new Promise<void>((resolve) => {
        overtaken = resolve;
      });

      // Identical to the real repository, except that it hands back a snapshot
      // and then waits, so the other runner can finish first.
      const stale: SubscriptionRepository = {
        insert: (uow, bundle) => fresh.insert(uow, bundle),
        update: (uow, bundle) => fresh.update(uow, bundle),
        lockById: (uow, id) => fresh.lockById(uow, id),
        findForUser: (id, user) => fresh.findForUser(id, user),
        listByUser: (user) => fresh.listByUser(user),
        findAwaitingPayment: (before, limit) => fresh.findAwaitingPayment(before, limit),
        findDue: async (at, limit) => {
          const rows = await fresh.findDue(at, limit);
          await held;
          return rows;
        },
      };

      const overtakenRun = new BillingService(
        live.container.database,
        stale,
        periods,
        gw,
        clock,
        60_000,
      ).run();

      await live.container.billing.run();
      overtaken();
      await overtakenRun;

      // Exactly one period was claimed and charged, and the subscription sits on
      // the end of that period - not a cycle beyond it.
      expect(gw.charges).toHaveLength(1);
      expect(await live.billingPeriods(bundleId)).toHaveLength(2);
      expect((await live.bundle(bundleId)).end_date.toISOString()).toBe('2026-07-19T10:00:00.000Z');
    } finally {
      await live.stop();
    }
  });
});
