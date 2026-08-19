import { DomainError } from '../../../shared/domain/errors.js';

/**
 * The provider did not answer. The reservation is reversed before this is
 * raised, so the user has not been charged, and the failure is marked retryable
 * so a client retrying with the same idempotency key is allowed a fresh attempt.
 */
export class AiProviderUnavailableError extends DomainError {
  readonly code = 'AI_PROVIDER_UNAVAILABLE';
  readonly httpStatus = 503;
  override readonly retryable = true;
}
