export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  /**
   * Whether repeating the identical request could plausibly succeed. It drives
   * idempotency bookkeeping: a deterministic refusal is recorded as this
   * operation's outcome, whereas a retryable failure releases the claim so the
   * same key may be attempted again.
   */
  readonly retryable: boolean = false;

  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;
}
