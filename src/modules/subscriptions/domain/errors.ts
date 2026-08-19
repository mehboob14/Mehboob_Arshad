import { DomainError } from '../../../shared/domain/errors.js';

/**
 * 402 rather than 429: the request is not being throttled, it is unfunded.
 * The payload carries everything a client needs to resolve it without a second
 * round trip — when the free grant returns, and what the user already owns.
 */
export class QuotaExceededError extends DomainError {
  readonly code = 'QUOTA_EXCEEDED';
  readonly httpStatus = 402;
}

/**
 * A conditional write found no row to update while the row was supposedly
 * locked. It should be unreachable; it exists so that a regression in the
 * locking strategy surfaces as a loud failure rather than as silent
 * over-consumption.
 */
export class AllowanceConflictError extends DomainError {
  readonly code = 'ALLOWANCE_CONFLICT';
  readonly httpStatus = 409;
}

/** The gateway answered, and the answer was no. Retrying the same card will not help. */
export class PaymentDeclinedError extends DomainError {
  readonly code = 'PAYMENT_DECLINED';
  readonly httpStatus = 402;
}

/** The requested transition is not legal from the subscription's current state. */
export class InvalidSubscriptionStateError extends DomainError {
  readonly code = 'INVALID_SUBSCRIPTION_STATE';
  readonly httpStatus = 409;
}

/**
 * The gateway did not answer, so it is unknown whether the card was charged.
 * Deliberately NOT retryable: replaying an unknown charge is how customers get
 * billed twice. The claimed billing period stays PENDING and is surfaced by the
 * billing run as needing reconciliation.
 */
export class PaymentGatewayUnavailableError extends DomainError {
  readonly code = 'PAYMENT_GATEWAY_UNAVAILABLE';
  readonly httpStatus = 502;
}
