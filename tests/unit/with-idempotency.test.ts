import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../src/shared/domain/clock.js';
import { DomainError } from '../../src/shared/domain/errors.js';
import type {
  ClaimRequest,
  ClaimResult,
  IdempotencyStore,
  SettleRequest,
} from '../../src/shared/idempotency/idempotency.js';
import { withIdempotency } from '../../src/shared/idempotency/with-idempotency.js';

const NOW = new Date('2026-08-19T10:00:00Z');
const CLAIMED_AT = new Date('2026-08-19T09:59:59Z');

class RetryableError extends DomainError {
  readonly code = 'PROVIDER_DOWN';
  readonly httpStatus = 503;
  override readonly retryable = true;
}

class FakeStore implements IdempotencyStore {
  settled: SettleRequest[] = [];
  released: { key: string; claimedAt: Date }[] = [];
  failSettle = false;

  claim(_request: ClaimRequest): Promise<ClaimResult> {
    return Promise.resolve({ outcome: 'CLAIMED', claimedAt: CLAIMED_AT });
  }

  settle(request: SettleRequest): Promise<void> {
    this.settled.push(request);
    return this.failSettle
      ? Promise.reject(new Error('Connection terminated unexpectedly'))
      : Promise.resolve();
  }

  release(_userId: string, key: string, claimedAt: Date): Promise<void> {
    this.released.push({ key, claimedAt });
    return Promise.resolve();
  }
}

function request(body: unknown = { question: 'hello' }): Request {
  return {
    method: 'POST',
    path: '/api/v1/chat/messages',
    userId: 'user-1',
    body,
    header: (name: string) => (name.toLowerCase() === 'idempotency-key' ? 'key-1' : undefined),
  } as unknown as Request;
}

function wrap(store: IdempotencyStore, controller: () => Promise<{ status: number }>) {
  return withIdempotency({ store, clock: new FixedClock(NOW), claimTimeoutMs: 60_000 }, () =>
    controller(),
  );
}

describe('withIdempotency', () => {
  it('does not release the claim when recording the outcome fails', async () => {
    // The controller committed its effect - quota spent, card charged. Losing
    // the bookkeeping write afterwards must not look like failed work: releasing
    // the claim here would let a retry run the whole thing a second time.
    const store = new FakeStore();
    store.failSettle = true;

    const result = await wrap(store, () => Promise.resolve({ status: 201 }))(request());

    expect(result.status).toBe(201);
    expect(store.released).toHaveLength(0);
  });

  it('releases the claim when the work itself failed retryably', async () => {
    const store = new FakeStore();

    await expect(
      wrap(store, () => Promise.reject(new RetryableError('provider down')))(request()),
    ).rejects.toThrow(/provider down/);

    expect(store.released).toHaveLength(1);
    expect(store.settled).toHaveLength(0);
  });

  it('proves ownership on every write, so a superseded claimant cannot clobber', async () => {
    const store = new FakeStore();

    await wrap(store, () => Promise.resolve({ status: 201 }))(request());

    expect(store.settled[0]?.claimedAt).toEqual(CLAIMED_AT);
  });

  it('records a deterministic refusal rather than releasing the claim', async () => {
    class Refusal extends DomainError {
      readonly code = 'QUOTA_EXCEEDED';
      readonly httpStatus = 402;
    }
    const store = new FakeStore();

    await expect(
      wrap(store, () => Promise.reject(new Refusal('no quota')))(request()),
    ).rejects.toThrow(/no quota/);

    expect(store.released).toHaveLength(0);
    expect(store.settled[0]?.status).toBe('FAILED');
    expect(store.settled[0]?.responseStatus).toBe(402);
  });
});
