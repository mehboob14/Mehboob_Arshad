import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../../src/shared/domain/clock.js';
import { Harness, RecordingGateway } from './harness.js';

const BASE = new Date('2026-08-19T10:00:00Z');
const NO_LATENCY = { AI_LATENCY_MIN_MS: 0, AI_LATENCY_MAX_MS: 0 };

interface SubscriptionBody {
  id: string;
  status: string;
  autoRenew: boolean;
  cancelAtPeriodEnd: boolean;
  endDate: string;
  renewalDate: string | null;
  remaining: number | null;
}

function subscription(body: Record<string, unknown>): SubscriptionBody {
  return body['subscription'] as SubscriptionBody;
}

describe('subscription purchase and cancellation', () => {
  const gateway = new RecordingGateway();
  const clock = new FixedClock(BASE);
  let harness: Harness;

  beforeAll(async () => {
    harness = await Harness.start({ config: NO_LATENCY, clock, paymentGateway: gateway });
  });

  afterAll(async () => {
    await harness.stop();
  });

  async function purchase(
    userId: string,
    body: Record<string, unknown> = { tier: 'BASIC', billingCycle: 'MONTHLY' },
    idempotencyKey?: string,
  ) {
    return harness.request('POST', '/api/v1/subscriptions', {
      userId,
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  it('activates the bundle and records a paid period when the charge succeeds', async () => {
    gateway.result = 'SUCCEEDED';
    const userId = await harness.createUser();

    const response = await purchase(userId, { tier: 'PRO', billingCycle: 'YEARLY' });
    const created = subscription(response.body);

    expect(response.status).toBe(201);
    expect(created.status).toBe('ACTIVE');
    expect(created.remaining).toBe(100);
    expect(created.endDate).toBe('2027-08-19T10:00:00.000Z');
    expect(created.renewalDate).toBe('2027-08-19T10:00:00.000Z');

    const periods = await harness.billingPeriods(created.id);
    expect(periods).toHaveLength(1);
    expect(periods[0]?.status).toBe('PAID');
  });

  it('refuses service when the first charge is declined', async () => {
    gateway.result = 'DECLINED';
    const userId = await harness.createUser();

    const response = await purchase(userId);
    expect(response.status).toBe(402);
    expect((response.body['error'] as { code: string }).code).toBe('PAYMENT_DECLINED');

    const bundleId = (response.body['error'] as { details: { subscriptionId: string } }).details
      .subscriptionId;
    expect((await harness.bundle(bundleId)).status).toBe('PAYMENT_FAILED');
    expect((await harness.billingPeriods(bundleId))[0]?.status).toBe('FAILED');

    // The free grant still applies; the unpaid bundle contributes nothing.
    for (let i = 0; i < 3; i++) await harness.ask({ userId, question: `free ${i}` });
    expect((await harness.ask({ userId, question: 'no bundle to fall back on' })).status).toBe(402);
  });

  it('charges once when a purchase is retried with the same idempotency key', async () => {
    gateway.result = 'SUCCEEDED';
    const userId = await harness.createUser();
    const before = gateway.charges.length;

    const first = await purchase(userId, { tier: 'BASIC', billingCycle: 'MONTHLY' }, 'buy-once');
    const second = await purchase(userId, { tier: 'BASIC', billingCycle: 'MONTHLY' }, 'buy-once');

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(gateway.charges.length - before).toBe(1);

    const listed = await harness.request('GET', '/api/v1/subscriptions', { userId });
    expect(listed.body['subscriptions']).toHaveLength(1);
  });

  it('never auto-retries a charge whose outcome is unknown', async () => {
    gateway.result = 'THROW';
    const userId = await harness.createUser();
    const before = gateway.charges.length;

    const failed = await purchase(userId, { tier: 'BASIC', billingCycle: 'MONTHLY' }, 'unknown');
    expect(failed.status).toBe(502);
    expect((failed.body['error'] as { code: string }).code).toBe('PAYMENT_GATEWAY_UNAVAILABLE');

    const retried = await purchase(userId, { tier: 'BASIC', billingCycle: 'MONTHLY' }, 'unknown');
    expect(retried.status).toBe(502);
    expect(gateway.charges.length - before).toBe(1);
  });

  it('keeps serving a cancelled subscription until the period it paid for ends', async () => {
    gateway.result = 'SUCCEEDED';
    const userId = await harness.createUser();
    const created = subscription((await purchase(userId)).body);

    const cancelled = subscription(
      (await harness.request('POST', `/api/v1/subscriptions/${created.id}/cancel`, { userId }))
        .body,
    );

    expect(cancelled.status).toBe('ACTIVE');
    expect(cancelled.cancelAtPeriodEnd).toBe(true);
    expect(cancelled.autoRenew).toBe(false);
    expect(cancelled.renewalDate).toBeNull();

    // Spend the free grant, then prove the cancelled bundle still pays.
    for (let i = 0; i < 3; i++) await harness.ask({ userId, question: `free ${i}` });
    expect((await harness.ask({ userId, question: 'still served' })).status).toBe(201);
    expect(await harness.bundleUsage(created.id)).toBe(1);
  });

  it('refuses to turn auto-renew back on after cancellation', async () => {
    gateway.result = 'SUCCEEDED';
    const userId = await harness.createUser();
    const created = subscription((await purchase(userId)).body);

    await harness.request('POST', `/api/v1/subscriptions/${created.id}/cancel`, { userId });
    const reenabled = await harness.request('PATCH', `/api/v1/subscriptions/${created.id}`, {
      userId,
      body: { autoRenew: true },
    });

    expect(reenabled.status).toBe(409);
    expect((reenabled.body['error'] as { code: string }).code).toBe('INVALID_SUBSCRIPTION_STATE');
  });

  it("does not reveal another user's subscription", async () => {
    gateway.result = 'SUCCEEDED';
    const owner = await harness.createUser();
    const stranger = await harness.createUser();
    const created = subscription((await purchase(owner)).body);

    const peek = await harness.request('GET', `/api/v1/subscriptions/${created.id}`, {
      userId: stranger,
    });
    const hijack = await harness.request('POST', `/api/v1/subscriptions/${created.id}/cancel`, {
      userId: stranger,
    });

    expect(peek.status).toBe(404);
    expect(hijack.status).toBe(404);
  });

  it('exposes billing periods as usage history', async () => {
    gateway.result = 'SUCCEEDED';
    const userId = await harness.createUser();
    const created = subscription((await purchase(userId)).body);

    const detail = await harness.request('GET', `/api/v1/subscriptions/${created.id}`, { userId });

    expect(detail.status).toBe(200);
    expect(detail.body['billingPeriods']).toHaveLength(1);
  });
});
