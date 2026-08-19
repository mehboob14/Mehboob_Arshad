import { addBillingCycle } from './billing-cycle.js';
import { InvalidSubscriptionStateError } from './errors.js';
import type { BillingCycle, BundleStatus, Tier } from './tier.js';
import { tierDefinition } from './tier.js';

export interface SubscriptionBundleState {
  readonly id: string;
  readonly userId: string;
  readonly tier: Tier;
  readonly billingCycle: BillingCycle;
  readonly status: BundleStatus;
  readonly maxMessages: number | null;
  readonly usedMessages: number;
  readonly priceCents: number;
  readonly currency: string;
  readonly autoRenew: boolean;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly renewalDate: Date | null;
  readonly cancelledAt: Date | null;
}

/**
 * The subscription aggregate. Every transition below is a method, so the legal
 * lifecycle is readable in one place rather than inferred from scattered
 * UPDATE statements:
 *
 *   PENDING_PAYMENT ──activate──▶ ACTIVE ──renew──▶ ACTIVE
 *          │                        │  │
 *          └──decline──▶ PAYMENT_FAILED │ (renewal declined)
 *                                    │  │
 *                        cancel ─────┘  └──close──▶ EXPIRED
 *                     (still serving)      (cancelled) CANCELLED
 *
 * Cancellation is deliberately not a status change: the user has paid for the
 * current period, so the bundle keeps serving until `endDate` and only the
 * renewal is stopped.
 */
export class SubscriptionBundle {
  private constructor(private readonly state: SubscriptionBundleState) {}

  static create(input: {
    id: string;
    userId: string;
    tier: Tier;
    billingCycle: BillingCycle;
    autoRenew: boolean;
    at: Date;
  }): SubscriptionBundle {
    const definition = tierDefinition(input.tier);
    const endDate = addBillingCycle(input.at, input.billingCycle);

    return new SubscriptionBundle({
      id: input.id,
      userId: input.userId,
      tier: input.tier,
      billingCycle: input.billingCycle,
      status: 'PENDING_PAYMENT',
      maxMessages: definition.maxMessages,
      usedMessages: 0,
      priceCents: definition.priceCents[input.billingCycle],
      currency: 'USD',
      autoRenew: input.autoRenew,
      startDate: input.at,
      endDate,
      renewalDate: input.autoRenew ? endDate : null,
      cancelledAt: null,
    });
  }

  static rehydrate(state: SubscriptionBundleState): SubscriptionBundle {
    return new SubscriptionBundle(state);
  }

  get id(): string {
    return this.state.id;
  }

  get userId(): string {
    return this.state.userId;
  }

  get tier(): Tier {
    return this.state.tier;
  }

  get status(): BundleStatus {
    return this.state.status;
  }

  get endDate(): Date {
    return this.state.endDate;
  }

  get usedMessages(): number {
    return this.state.usedMessages;
  }

  get priceCents(): number {
    return this.state.priceCents;
  }

  get isUnlimited(): boolean {
    return this.state.maxMessages === null;
  }

  /** Cancelled by the user, but still inside the period they paid for. */
  get isCancelling(): boolean {
    return this.state.cancelledAt !== null && this.state.status === 'ACTIVE';
  }

  /** null when the tier is unmetered. */
  get remaining(): number | null {
    return this.state.maxMessages === null
      ? null
      : Math.max(0, this.state.maxMessages - this.state.usedMessages);
  }

  isServingAt(instant: Date): boolean {
    return (
      this.state.status === 'ACTIVE' &&
      this.state.startDate.getTime() <= instant.getTime() &&
      this.state.endDate.getTime() > instant.getTime()
    );
  }

  canServeMessageAt(instant: Date): boolean {
    return this.isServingAt(instant) && (this.isUnlimited || (this.remaining ?? 0) > 0);
  }

  /** The period has run out; the bundle now either renews or closes. */
  isDueAt(instant: Date): boolean {
    return this.state.status === 'ACTIVE' && this.state.endDate.getTime() <= instant.getTime();
  }

  shouldRenewAt(instant: Date): boolean {
    return this.isDueAt(instant) && this.state.autoRenew && this.state.cancelledAt === null;
  }

  activate(): SubscriptionBundle {
    this.assertStatus('PENDING_PAYMENT', 'activate');
    return this.with({ status: 'ACTIVE' });
  }

  declinePayment(): SubscriptionBundle {
    return this.with({ status: 'PAYMENT_FAILED', autoRenew: false, renewalDate: null });
  }

  cancel(at: Date): SubscriptionBundle {
    if (this.state.cancelledAt !== null) {
      throw new InvalidSubscriptionStateError('This subscription is already cancelled.');
    }
    this.assertStatus('ACTIVE', 'cancel');
    return this.with({ cancelledAt: at, autoRenew: false, renewalDate: null });
  }

  setAutoRenew(autoRenew: boolean): SubscriptionBundle {
    if (autoRenew && this.state.cancelledAt !== null) {
      throw new InvalidSubscriptionStateError(
        'A cancelled subscription cannot be set to renew; create a new one instead.',
      );
    }
    this.assertStatus('ACTIVE', 'change auto-renew on');
    return this.with({ autoRenew, renewalDate: autoRenew ? this.state.endDate : null });
  }

  /** Opens the next period. The message allowance belongs to a period, so it resets. */
  renew(): SubscriptionBundle {
    const startDate = this.state.endDate;
    const endDate = addBillingCycle(startDate, this.state.billingCycle);
    return this.with({
      status: 'ACTIVE',
      startDate,
      endDate,
      renewalDate: this.state.autoRenew ? endDate : null,
      usedMessages: 0,
    });
  }

  /** Terminal. Which terminal state depends on who ended it. */
  close(): SubscriptionBundle {
    return this.with({
      status: this.state.cancelledAt === null ? 'EXPIRED' : 'CANCELLED',
      autoRenew: false,
      renewalDate: null,
    });
  }

  nextPeriod(): { start: Date; end: Date } {
    const start = this.state.endDate;
    return { start, end: addBillingCycle(start, this.state.billingCycle) };
  }

  snapshot(): SubscriptionBundleState {
    return this.state;
  }

  private with(changes: Partial<SubscriptionBundleState>): SubscriptionBundle {
    return new SubscriptionBundle({ ...this.state, ...changes });
  }

  private assertStatus(expected: BundleStatus, action: string): void {
    if (this.state.status !== expected) {
      throw new InvalidSubscriptionStateError(
        `Cannot ${action} a subscription that is ${this.state.status}.`,
        { status: this.state.status, expected },
      );
    }
  }
}
