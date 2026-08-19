import type { AllowanceCharge } from '../../../shared/domain/allowance.js';
import type { UnitOfWork } from '../../../shared/persistence/unit-of-work.js';
import type { BillingPeriod, NewBillingPeriod } from './billing-period.js';
import type { EntitlementSnapshot } from './entitlement-policy.js';
import type { SubscriptionBundle } from './subscription-bundle.js';

export interface EntitlementSummary {
  readonly free: {
    readonly granted: number;
    readonly used: number;
    readonly remaining: number;
    readonly resetsAt: string;
  };
  readonly bundles: readonly {
    readonly id: string;
    readonly tier: string;
    readonly billingCycle: string;
    readonly maxMessages: number | null;
    readonly usedMessages: number;
    readonly remaining: number | null;
    readonly endDate: string;
    readonly autoRenew: boolean;
  }[];
  readonly totalRemaining: number | null;
}

export interface EntitlementRepository {
  /**
   * Loads every allowance the user could draw on and holds it against
   * concurrent modification for the life of the unit of work.
   */
  loadForUpdate(
    uow: UnitOfWork,
    userId: string,
    at: Date,
    freeGrant: number,
  ): Promise<EntitlementSnapshot>;

  /** Applies a deduction. Returns false when the balance moved underneath us. */
  applyCharge(uow: UnitOfWork, userId: string, charge: AllowanceCharge): Promise<boolean>;

  /** Reverses a deduction after downstream work failed. */
  reverseCharge(uow: UnitOfWork, userId: string, charge: AllowanceCharge): Promise<void>;

  summarise(userId: string, at: Date, freeGrant: number): Promise<EntitlementSummary>;
}

export interface SubscriptionRepository {
  insert(uow: UnitOfWork, bundle: SubscriptionBundle): Promise<void>;
  update(uow: UnitOfWork, bundle: SubscriptionBundle): Promise<void>;
  lockById(uow: UnitOfWork, bundleId: string): Promise<SubscriptionBundle | null>;
  findForUser(bundleId: string, userId: string): Promise<SubscriptionBundle | null>;
  listByUser(userId: string): Promise<SubscriptionBundle[]>;
  /** Bundles whose paid period has run out and which now renew or close. */
  findDue(at: Date, limit: number): Promise<SubscriptionBundle[]>;
  /** Bundles whose first charge never resolved, and whose outcome is unknown. */
  findAwaitingPayment(before: Date, limit: number): Promise<SubscriptionBundle[]>;
}

export interface BillingPeriodRepository {
  /**
   * Claims the right to bill a period. Returns false when another run already
   * holds the claim — the UNIQUE constraint, not the caller, decides.
   */
  open(uow: UnitOfWork, period: NewBillingPeriod): Promise<boolean>;
  find(uow: UnitOfWork, bundleId: string, periodStart: Date): Promise<BillingPeriod | null>;
  settle(
    uow: UnitOfWork,
    bundleId: string,
    periodStart: Date,
    outcome:
      { status: 'PAID'; paymentReference: string } | { status: 'FAILED'; declineReason: string },
    at: Date,
  ): Promise<void>;
  /** Snapshots a period's closing usage before the bundle's counter is reset. */
  recordUsage(
    uow: UnitOfWork,
    bundleId: string,
    periodEnd: Date,
    messagesUsed: number,
  ): Promise<void>;
  listByBundle(bundleId: string): Promise<BillingPeriod[]>;
}
