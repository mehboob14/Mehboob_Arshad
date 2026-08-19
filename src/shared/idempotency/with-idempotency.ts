import type { Clock } from '../domain/clock.js';
import { isTransient, mapError } from '../http/error-handler.js';
import type { Controller } from '../http/http-result.js';
import type { IdempotencyStore } from './idempotency.js';
import {
  fingerprintRequest,
  IdempotencyKeyReusedError,
  RequestInProgressError,
} from './idempotency.js';

export interface IdempotencyOptions {
  store: IdempotencyStore;
  clock: Clock;
  claimTimeoutMs: number;
}

const RETRY_AFTER_SECONDS = 1;

/**
 * Wraps a controller so that a repeated request carrying the same
 * Idempotency-Key produces the same recorded outcome instead of a second
 * effect. The key is claimed *before* the work runs, so a retry that arrives
 * while the original is still in flight is refused rather than duplicated.
 *
 * The header is optional, matching how payment APIs behave: a client that
 * intends to retry is responsible for supplying a key. Without one, a retry is
 * indistinguishable from a new request and is billed as such.
 */
export function withIdempotency(options: IdempotencyOptions, controller: Controller): Controller {
  return async (req) => {
    const key = req.header('idempotency-key');
    if (!key) return controller(req);

    const identity = {
      userId: req.userId,
      key,
      fingerprint: fingerprintRequest({
        method: req.method,
        path: req.path,
        userId: req.userId,
        body: req.body,
      }),
    };

    const claim = await options.store.claim({
      ...identity,
      staleClaimsBefore: new Date(options.clock.now().getTime() - options.claimTimeoutMs),
    });

    switch (claim.outcome) {
      case 'FINGERPRINT_MISMATCH':
        throw new IdempotencyKeyReusedError(
          'This idempotency key was already used with a different request body.',
          { idempotencyKey: key },
        );

      case 'IN_PROGRESS':
        throw new RequestInProgressError(
          'A request with this idempotency key is still being processed.',
          { idempotencyKey: key, retryAfterSeconds: RETRY_AFTER_SECONDS },
        );

      case 'REPLAY':
        return {
          status: claim.status,
          body: claim.body,
          headers: { 'Idempotency-Replayed': 'true' },
        };

      case 'CLAIMED':
        break;
    }

    try {
      const result = await controller(req);
      await options.store.settle({
        ...identity,
        status: 'COMPLETED',
        responseStatus: result.status,
        responseBody: result.body ?? null,
      });
      return result;
    } catch (error) {
      // A deterministic rejection is part of this operation's outcome and is
      // recorded, so replays see the same refusal. An infrastructure failure is
      // not an outcome at all: the claim is released so the same key can retry.
      if (isTransient(error)) {
        await options.store.release(identity.userId, identity.key).catch(() => undefined);
        throw error;
      }
      const mapped = mapError(error);
      await options.store.settle({
        ...identity,
        status: 'FAILED',
        responseStatus: mapped.status,
        responseBody: mapped.body,
      });
      throw error;
    }
  };
}
