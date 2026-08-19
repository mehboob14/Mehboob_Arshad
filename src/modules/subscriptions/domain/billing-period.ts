export type BillingPeriodStatus = 'PENDING' | 'PAID' | 'FAILED';

/**
 * One period a bundle has been billed for. It is a record rather than an
 * entity: its whole state machine is claim → settle, and every transition is a
 * conditional write that only the database can make atomically, so there is no
 * behaviour left for an object to own.
 */
export interface BillingPeriod {
  readonly id: string;
  readonly bundleId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly priceCents: number;
  readonly currency: string;
  readonly status: BillingPeriodStatus;
  readonly paymentReference: string | null;
  readonly declineReason: string | null;
  readonly messagesUsed: number;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
}

export interface NewBillingPeriod {
  readonly bundleId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly priceCents: number;
  readonly currency: string;
}

/**
 * The gateway idempotency key. Derived from the bundle and the period it pays
 * for, so a retried billing run produces the identical reference and the
 * gateway can recognise it as the same charge.
 */
export function paymentReferenceFor(bundleId: string, periodStart: Date): string {
  return `sub_${bundleId}_${periodStart.toISOString()}`;
}
