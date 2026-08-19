import type { Clock } from '../domain/clock.js';
import { isTransient, mapError } from '../http/error-handler.js';
import type { Controller, HttpResult } from '../http/http-result.js';
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

    const at = options.clock.now();
    const claim = await options.store.claim({
      ...identity,
      at,
      staleClaimsBefore: new Date(at.getTime() - options.claimTimeoutMs),
    });

    if (claim.outcome === 'FINGERPRINT_MISMATCH') {
      throw new IdempotencyKeyReusedError(
        'This idempotency key was already used with a different request body.',
        { idempotencyKey: key },
      );
    }

    if (claim.outcome === 'IN_PROGRESS') {
      throw new RequestInProgressError(
        'A request with this idempotency key is still being processed.',
        { idempotencyKey: key, retryAfterSeconds: RETRY_AFTER_SECONDS },
      );
    }

    if (claim.outcome === 'REPLAY') {
      return {
        status: claim.status,
        body: claim.body,
        headers: { 'Idempotency-Replayed': 'true' },
      };
    }

    // Proof of ownership for every write below. If this claim is taken over
    // while the work runs, the token stops this request from clobbering its
    // successor.
    const owner = { claimedAt: claim.claimedAt };

    let result: HttpResult;
    try {
      result = await controller(req);
    } catch (error) {
      // A deterministic rejection is part of this operation's outcome and is
      // recorded, so replays see the same refusal. An infrastructure failure is
      // not an outcome at all: the claim is released so the same key can retry.
      if (isTransient(error)) {
        await options.store
          .release(identity.userId, identity.key, owner.claimedAt)
          .catch(() => undefined);
        throw error;
      }
      const mapped = mapError(error);
      // A lost bookkeeping write must not replace the client's real refusal
      // with a 500; the claim stays PROCESSING and a retry gets 409.
      await options.store
        .settle({
          ...identity,
          ...owner,
          status: 'FAILED',
          responseStatus: mapped.status,
          responseBody: mapped.body,
        })
        .catch(() => undefined);
      throw error;
    }

    // Deliberately outside the try. The effect has already been committed by the
    // controller, so a failure to record it is not a failure of the request:
    // treating it as one would release the claim and let a retry run the work a
    // second time - spending quota twice, or charging a card twice, because a
    // retried purchase mints a new subscription id and so a new gateway
    // reference that nothing can deduplicate. Leaving the claim PROCESSING makes
    // that retry a 409 instead, which is recoverable; a duplicate charge is not.
    await options.store
      .settle({
        ...identity,
        ...owner,
        status: 'COMPLETED',
        responseStatus: result.status,
        responseBody: result.body ?? null,
      })
      .catch(() => undefined);

    return result;
  };
}
