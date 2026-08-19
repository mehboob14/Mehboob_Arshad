import type { AllowanceCharge, GrantedAllowance } from '../../../shared/domain/allowance.js';
import type { UnitOfWork } from '../../../shared/persistence/unit-of-work.js';
import type { EntitlementSnapshot } from '../domain/entitlement-policy.js';
import { selectAllowance } from '../domain/entitlement-policy.js';
import { AllowanceConflictError, QuotaExceededError } from '../domain/errors.js';
import type { EntitlementRepository, EntitlementSummary } from '../domain/ports.js';

export class EntitlementService {
  constructor(
    private readonly repository: EntitlementRepository,
    private readonly freeMessagesPerMonth: number,
  ) {}

  /**
   * Reserves one message against the user's allowances inside the caller's
   * transaction. Three independent defences stop a concurrent pair of requests
   * from spending the same last credit:
   *
   *   1. `loadForUpdate` holds row locks on every candidate allowance, so two
   *      requests for one user are serialised at the balance, not at the API.
   *   2. `applyCharge` re-asserts the balance in its WHERE clause, so a write
   *      that somehow escaped the lock still cannot overdraw.
   *   3. CHECK constraints on the tables refuse a negative or over-limit
   *      balance outright, whatever the application believes.
   */
  async consume(uow: UnitOfWork, userId: string, at: Date): Promise<GrantedAllowance> {
    const snapshot = await this.repository.loadForUpdate(
      uow,
      userId,
      at,
      this.freeMessagesPerMonth,
    );

    const granted = selectAllowance(snapshot, at);
    if (!granted) throw new QuotaExceededError(QUOTA_MESSAGE, quotaDetails(snapshot, at));

    const applied = await this.repository.applyCharge(uow, userId, granted.charge);
    if (!applied) {
      throw new AllowanceConflictError('The allowance balance changed while it was being spent.');
    }
    return granted;
  }

  async refund(uow: UnitOfWork, userId: string, charge: AllowanceCharge): Promise<void> {
    await this.repository.reverseCharge(uow, userId, charge);
  }

  summarise(userId: string, at: Date): Promise<EntitlementSummary> {
    return this.repository.summarise(userId, at, this.freeMessagesPerMonth);
  }
}

const QUOTA_MESSAGE =
  'The free monthly allowance is spent and no subscription bundle has remaining quota.';

function quotaDetails(snapshot: EntitlementSnapshot, at: Date): Record<string, unknown> {
  return {
    freeRemaining: snapshot.freeAllowance.remaining,
    freeResetsAt: snapshot.freeAllowance.resetsAt.toISOString(),
    activeBundles: snapshot.bundles
      .filter((bundle) => bundle.isServingAt(at))
      .map((bundle) => ({
        id: bundle.id,
        tier: bundle.tier,
        remaining: bundle.remaining,
        endDate: bundle.endDate.toISOString(),
      })),
    resolution: 'Purchase a subscription bundle, or wait for the free allowance to reset.',
  };
}
