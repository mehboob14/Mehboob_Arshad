import { createHash } from 'node:crypto';
import { DomainError } from '../domain/errors.js';

export type SettledStatus = 'COMPLETED' | 'FAILED';

export type ClaimResult =
  | { outcome: 'CLAIMED' }
  | { outcome: 'REPLAY'; status: number; body: unknown }
  | { outcome: 'IN_PROGRESS' }
  | { outcome: 'FINGERPRINT_MISMATCH' };

export interface ClaimRequest {
  userId: string;
  key: string;
  fingerprint: string;
  staleClaimsBefore: Date;
}

export interface SettleRequest {
  userId: string;
  key: string;
  status: SettledStatus;
  responseStatus: number;
  responseBody: unknown;
}

export interface IdempotencyStore {
  claim(request: ClaimRequest): Promise<ClaimResult>;
  settle(request: SettleRequest): Promise<void>;
  release(userId: string, key: string): Promise<void>;
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
