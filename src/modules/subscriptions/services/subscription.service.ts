import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../shared/domain/clock.js';
import { NotFoundError } from '../../../shared/domain/errors.js';
import type { TransactionManager } from '../../../shared/persistence/unit-of-work.js';
import type { BillingPeriod } from '../domain/billing-period.js';
import { paymentReferenceFor } from '../domain/billing-period.js';
import { PaymentDeclinedError, PaymentGatewayUnavailableError } from '../domain/errors.js';
import type { PaymentGateway, PaymentResult } from '../domain/payment.js';
import type { BillingPeriodRepository, SubscriptionRepository } from '../domain/ports.js';
import { SubscriptionBundle } from '../domain/subscription-bundle.js';
import type { BillingCycle, Tier } from '../domain/tier.js';

export interface CreateSubscriptionCommand {
  readonly userId: string;
  readonly tier: Tier;
  readonly billingCycle: BillingCycle;
  readonly autoRenew: boolean;
}

export class SubscriptionService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly subscriptions: SubscriptionRepository,
    private readonly periods: BillingPeriodRepository,
    private readonly payments: PaymentGateway,
    private readonly clock: Clock,
  ) {}

  /**
   * Record, charge, settle — the same shape as sending a chat message, for the
   * same reason.
   *
   * The bundle and its first billing period are written and committed *before*
   * the gateway is called. The period row carries `UNIQUE (bundle_id,
   * period_start)`, so the charge is claimed rather than merely attempted, and
   * the bundle starts in PENDING_PAYMENT so an unpaid subscription cannot serve
   * a single message in the window before the charge settles.
   */
  async create(command: CreateSubscriptionCommand): Promise<SubscriptionBundle> {
    const at = this.clock.now();
    const bundle = SubscriptionBundle.create({ id: randomUUID(), ...command, at });
    const state = bundle.snapshot();

    await this.transactions.withTransaction(async (uow) => {
      await this.subscriptions.insert(uow, bundle);
      await this.periods.open(uow, {
        bundleId: state.id,
        periodStart: state.startDate,
        periodEnd: state.endDate,
        priceCents: state.priceCents,
        currency: state.currency,
      });
    });

    const payment = await this.charge(bundle);
    const settled = payment.outcome === 'SUCCEEDED' ? bundle.activate() : bundle.declinePayment();

    await this.transactions.withTransaction(async (uow) => {
      await this.periods.settle(uow, state.id, state.startDate, toSettlement(payment), at);
      await this.subscriptions.update(uow, settled);
    });

    if (payment.outcome === 'DECLINED') {
      throw new PaymentDeclinedError('The payment for this subscription was declined.', {
        subscriptionId: state.id,
        reason: payment.reason,
        status: settled.status,
      });
    }
    return settled;
  }

  /**
   * Ends the subscription at the end of the period the user has already paid
   * for: renewal stops, service continues, and nothing is deleted.
   */
  async cancel(userId: string, subscriptionId: string): Promise<SubscriptionBundle> {
    return this.mutate(userId, subscriptionId, (bundle) => bundle.cancel(this.clock.now()));
  }

  async setAutoRenew(
    userId: string,
    subscriptionId: string,
    autoRenew: boolean,
  ): Promise<SubscriptionBundle> {
    return this.mutate(userId, subscriptionId, (bundle) => bundle.setAutoRenew(autoRenew));
  }

  list(userId: string): Promise<SubscriptionBundle[]> {
    return this.subscriptions.listByUser(userId);
  }

  async detail(
    userId: string,
    subscriptionId: string,
  ): Promise<{ bundle: SubscriptionBundle; periods: BillingPeriod[] }> {
    const bundle = await this.subscriptions.findForUser(subscriptionId, userId);
    if (!bundle) throw notFound(subscriptionId);
    return { bundle, periods: await this.periods.listByBundle(subscriptionId) };
  }

  private async charge(bundle: SubscriptionBundle): Promise<PaymentResult> {
    const state = bundle.snapshot();
    try {
      return await this.payments.charge({
        reference: paymentReferenceFor(state.id, state.startDate),
        userId: state.userId,
        amountCents: state.priceCents,
        currency: state.currency,
        description: `${state.tier} bundle, billed ${state.billingCycle.toLowerCase()}`,
      });
    } catch {
      throw new PaymentGatewayUnavailableError(
        'The payment provider did not respond; this subscription needs reconciliation.',
        { subscriptionId: state.id },
      );
    }
  }

  /**
   * Read-modify-write under a row lock, so two clients cancelling at once
   * cannot each act on a stale copy of the subscription.
   */
  private async mutate(
    userId: string,
    subscriptionId: string,
    change: (bundle: SubscriptionBundle) => SubscriptionBundle,
  ): Promise<SubscriptionBundle> {
    return this.transactions.withTransaction(async (uow) => {
      const bundle = await this.subscriptions.lockById(uow, subscriptionId);
      // Not-found rather than forbidden: another user's subscription id should
      // not be distinguishable from one that does not exist.
      if (!bundle || bundle.userId !== userId) throw notFound(subscriptionId);

      const changed = change(bundle);
      await this.subscriptions.update(uow, changed);
      return changed;
    });
  }
}

function notFound(subscriptionId: string): NotFoundError {
  return new NotFoundError('No such subscription.', { subscriptionId });
}

export function toSettlement(
  payment: PaymentResult,
): { status: 'PAID'; paymentReference: string } | { status: 'FAILED'; declineReason: string } {
  return payment.outcome === 'SUCCEEDED'
    ? { status: 'PAID', paymentReference: payment.reference }
    : { status: 'FAILED', declineReason: payment.reason };
}
