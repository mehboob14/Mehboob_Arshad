import { createHash } from 'node:crypto';
import { DomainError } from '../domain/errors.js';

export type SettledStatus = 'COMPLETED' | 'FAILED';

export type ClaimResult =
  /**
   * `claimedAt` is a fencing token. A claim can change hands when its owner
   * stalls past the timeout, and a stalled owner is not necessarily a dead one:
   * it can come back and try to settle or release a claim that is no longer
   * its own. Carrying the instant it took ownership lets every later write say
   * "only if I am still the owner", so a superseded request updates nothing
   * instead of overwriting the new owner's response or deleting a live claim.
   */
  | { outcome: 'CLAIMED'; claimedAt: Date }
  | { outcome: 'REPLAY'; status: number; body: unknown }
  | { outcome: 'IN_PROGRESS' }
  | { outcome: 'FINGERPRINT_MISMATCH' };

export interface ClaimRequest {
  userId: string;
  key: string;
  fingerprint: string;
  /** Stamped onto the claim, and compared against on every later write. */
  at: Date;
  staleClaimsBefore: Date;
}

export interface SettleRequest {
  userId: string;
  key: string;
  claimedAt: Date;
  status: SettledStatus;
  responseStatus: number;
  responseBody: unknown;
}

export interface IdempotencyStore {
  claim(request: ClaimRequest): Promise<ClaimResult>;
  settle(request: SettleRequest): Promise<void>;
  release(userId: string, key: string, claimedAt: Date): Promise<void>;
}

export class IdempotencyKeyReusedError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
  readonly httpStatus = 422;
}

export class RequestInProgressError extends DomainError {
  readonly code = 'REQUEST_IN_PROGRESS';
  readonly httpStatus = 409;
}

/**
 * Canonical form of a value: object keys sorted at every depth, so two
 * semantically identical payloads always hash the same regardless of the order
 * the client serialised them in.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalise(v)]),
    );
  }
  return value;
}

export function fingerprintRequest(parts: {
  method: string;
  path: string;
  userId: string;
  body: unknown;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalise(parts)))
    .digest('hex');
}
