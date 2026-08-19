import type { Clock } from '../../../shared/domain/clock.js';
import type { TransactionManager } from '../../../shared/persistence/unit-of-work.js';
import { paymentReferenceFor } from '../domain/billing-period.js';
import type { PaymentGateway, PaymentResult } from '../domain/payment.js';
import type { BillingPeriodRepository, SubscriptionRepository } from '../domain/ports.js';
import type { SubscriptionBundle } from '../domain/subscription-bundle.js';
import { toSettlement } from './subscription.service.js';

export interface BillingRunReport {
  readonly processedAt: string;
  /** Charged and rolled into a new period. */
  readonly renewed: string[];
  /** Payment declined; the subscription is no longer serving. */
  readonly declined: string[];
  /** Reached the end of its final period: cancelled by the user, or expired. */
  readonly closed: string[];
  /** A charge whose outcome is unknown. Never retried automatically. */
  readonly needsReconciliation: string[];
}

interface MutableReport {
  renewed: string[];
  declined: string[];
  closed: string[];
  needsReconciliation: string[];
}

export class BillingService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly subscriptions: SubscriptionRepository,
    private readonly periods: BillingPeriodRepository,
    private readonly payments: PaymentGateway,
    private readonly clock: Clock,
    private readonly stalePeriodMs: number,
  ) {}

  /**
   * Advances every subscription whose paid period has run out.
   *
   * Safe to run concurrently with itself and safe to re-run after a crash: the
   * work is claimed one billing period at a time by inserting a row whose
   * UNIQUE (bundle_id, period_start) constraint admits exactly one claimant.
   * A second runner finds the claim taken and leaves it alone.
   *
   * One subscription's failure never stops the batch — each is its own
   * transaction, and each is reported individually.
   */
  async run(limit = 100): Promise<BillingRunReport> {
    const at = this.clock.now();
    const report: MutableReport = {
      renewed: [],
      declined: [],
      closed: [],
      needsReconciliation: [],
    };

    for (const bundle of await this.subscriptions.findDue(at, limit)) {
      if (bundle.shouldRenewAt(at)) await this.renew(bundle, at, report);
      else await this.close(bundle, at, report);
    }

    const stuck = await this.subscriptions.findAwaitingPayment(
      new Date(at.getTime() - this.stalePeriodMs),
      limit,
    );
    report.needsReconciliation.push(...stuck.map((bundle) => bundle.id));

    return { processedAt: at.toISOString(), ...report };
  }

  private async renew(bundle: SubscriptionBundle, at: Date, report: MutableReport): Promise<void> {
    const period = bundle.nextPeriod();
    const state = bundle.snapshot();

    const claimed = await this.transactions.withTransaction((uow) =>
      this.periods.open(uow, {
        bundleId: bundle.id,
        periodStart: period.start,
        periodEnd: period.end,
        priceCents: state.priceCents,
        currency: state.currency,
      }),
    );

    const payment = claimed
      ? await this.chargeClaimed(bundle, period.start)
      : await this.recoverOutcome(bundle, period.start);

    // Unknown outcome. The claim stays PENDING so no automatic retry can charge
    // the same period again; a human, or a gateway lookup, resolves it.
    if (!payment) {
      report.needsReconciliation.push(bundle.id);
      return;
    }

    await this.transactions.withTransaction(async (uow) => {
      const locked = await this.subscriptions.lockById(uow, bundle.id);
      // Another runner finished this renewal between the claim and here.
      if (!locked?.isDueAt(at)) return;

      await this.periods.settle(uow, bundle.id, period.start, toSettlement(payment), at);
      await this.periods.recordUsage(uow, bundle.id, locked.endDate, locked.usedMessages);

      if (payment.outcome === 'SUCCEEDED') {
        await this.subscriptions.update(uow, locked.renew());
        report.renewed.push(bundle.id);
      } else {
        await this.subscriptions.update(uow, locked.declinePayment());
        report.declined.push(bundle.id);
      }
    });
  }

  private async close(bundle: SubscriptionBundle, at: Date, report: MutableReport): Promise<void> {
    await this.transactions.withTransaction(async (uow) => {
      const locked = await this.subscriptions.lockById(uow, bundle.id);
      if (!locked?.isDueAt(at)) return;

      // Usage history outlives the subscription that produced it.
      await this.periods.recordUsage(uow, bundle.id, locked.endDate, locked.usedMessages);
      await this.subscriptions.update(uow, locked.close());
      report.closed.push(bundle.id);
    });
  }

  private async chargeClaimed(
    bundle: SubscriptionBundle,
    periodStart: Date,
  ): Promise<PaymentResult | null> {
    const state = bundle.snapshot();
    try {
      return await this.payments.charge({
        reference: paymentReferenceFor(bundle.id, periodStart),
        userId: state.userId,
        amountCents: state.priceCents,
        currency: state.currency,
        description: `${state.tier} bundle renewal, billed ${state.billingCycle.toLowerCase()}`,
      });
    } catch {
      return null;
    }
  }

  /**
   * The claim was already held. Either a previous attempt settled it — in which
   * case its recorded outcome is replayed so the subscription still advances —
   * or it is still open and the money is in an unknown state.
   */
  private async recoverOutcome(
    bundle: SubscriptionBundle,
    periodStart: Date,
  ): Promise<PaymentResult | null> {
    const existing = await this.transactions.withTransaction((uow) =>
      this.periods.find(uow, bundle.id, periodStart),
    );

    if (!existing || existing.status === 'PENDING') return null;
    return existing.status === 'PAID'
      ? { outcome: 'SUCCEEDED', reference: existing.paymentReference ?? '' }
      : { outcome: 'DECLINED', reason: existing.declineReason ?? 'unknown' };
  }
}
