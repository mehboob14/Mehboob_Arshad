import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../../src/shared/domain/clock.js';
import { Harness, RecordingGateway } from './harness.js';

const BASE = new Date('2026-08-19T10:00:00Z');
const PERIOD_END = new Date('2026-09-19T10:00:00Z');
const AFTER_PERIOD = new Date('2026-09-19T10:00:01Z');

// No free messages, so every message provably comes out of the bundle.
const CONFIG = { AI_LATENCY_MIN_MS: 0, AI_LATENCY_MAX_MS: 0, FREE_MESSAGES_PER_MONTH: 0 };

interface RunReport {
  renewed: string[];
  declined: string[];
  closed: string[];
  needsReconciliation: string[];
}

describe('billing run', () => {
  let harness: Harness;
  let gateway: RecordingGateway;
  let clock: FixedClock;

  beforeEach(async () => {
    gateway = new RecordingGateway();
    clock = new FixedClock(BASE);
    harness = await Harness.start({ config: CONFIG, clock, paymentGateway: gateway });
  });

  afterEach(async () => {
    await harness.stop();
  });

  async function bundleDueForRenewal(options: { autoRenew?: boolean } = {}): Promise<{
    userId: string;
    bundleId: string;
  }> {
    const userId = await harness.createUser();
    const bundleId = await harness.giveBundle(userId, {
      tier: 'BASIC',
      startDate: BASE,
      endDate: PERIOD_END,
      autoRenew: options.autoRenew ?? true,
    });
    return { userId, bundleId };
  }

  it('renews, resets the allowance, and keeps the closed period as history', async () => {
    const { userId, bundleId } = await bundleDueForRenewal();
    for (let i = 0; i < 2; i++) await harness.ask({ userId, question: `q${i}` });
    expect(await harness.bundleUsage(bundleId)).toBe(2);

    clock.travelTo(AFTER_PERIOD);
    const report = (await harness.runBilling()).body as unknown as RunReport;

    expect(report.renewed).toContain(bundleId);
    expect(gateway.charges).toHaveLength(1);

    const bundle = await harness.bundle(bundleId);
    expect(bundle.status).toBe('ACTIVE');
    expect(bundle.used_messages).toBe(0);
    expect(bundle.start_date.toISOString()).toBe('2026-09-19T10:00:00.000Z');
    expect(bundle.end_date.toISOString()).toBe('2026-10-19T10:00:00.000Z');

    const periods = await harness.billingPeriods(bundleId);
    expect(periods).toHaveLength(2);
    // The closed period keeps what was spent in it, even though the counter reset.
    expect(periods[0]?.messages_used).toBe(2);
    expect(periods[1]?.status).toBe('PAID');

    // The renewed allowance is spendable.
    expect((await harness.ask({ userId, question: 'new period' })).status).toBe(201);
  });

  it('stops service when the renewal payment is declined', async () => {
    const { userId, bundleId } = await bundleDueForRenewal();
    gateway.result = 'DECLINED';

    clock.travelTo(AFTER_PERIOD);
    const report = (await harness.runBilling()).body as unknown as RunReport;

    expect(report.declined).toContain(bundleId);

    const bundle = await harness.bundle(bundleId);
    expect(bundle.status).toBe('PAYMENT_FAILED');
    expect(bundle.auto_renew).toBe(false);
    expect((await harness.billingPeriods(bundleId))[1]?.status).toBe('FAILED');

    expect((await harness.ask({ userId, question: 'no longer funded' })).status).toBe(402);
  });

  it('charges once when the run is repeated', async () => {
    const { bundleId } = await bundleDueForRenewal();

    clock.travelTo(AFTER_PERIOD);
    await harness.runBilling();
    await harness.runBilling();

    expect(gateway.charges).toHaveLength(1);
    expect(await harness.billingPeriods(bundleId)).toHaveLength(2);
  });

  it('charges once when two runs execute concurrently', async () => {
    const { bundleId } = await bundleDueForRenewal();

    clock.travelTo(AFTER_PERIOD);
    await Promise.all([harness.runBilling(), harness.runBilling(), harness.runBilling()]);

    expect(gateway.charges).toHaveLength(1);
    expect((await harness.bundle(bundleId)).status).toBe('ACTIVE');
    expect(await harness.billingPeriods(bundleId)).toHaveLength(2);
  });

  it('expires a subscription that was never set to renew, without charging', async () => {
    const { bundleId } = await bundleDueForRenewal({ autoRenew: false });

    clock.travelTo(AFTER_PERIOD);
    const report = (await harness.runBilling()).body as unknown as RunReport;

    expect(report.closed).toContain(bundleId);
    expect(gateway.charges).toHaveLength(0);
    expect((await harness.bundle(bundleId)).status).toBe('EXPIRED');
  });

  it('closes a cancelled subscription as CANCELLED and preserves its usage', async () => {
    const { userId, bundleId } = await bundleDueForRenewal();
    await harness.ask({ userId, question: 'used before cancelling' });
    await harness.request('POST', `/api/v1/subscriptions/${bundleId}/cancel`, { userId });

    clock.travelTo(AFTER_PERIOD);
    const report = (await harness.runBilling()).body as unknown as RunReport;

    expect(report.closed).toContain(bundleId);
    expect(gateway.charges).toHaveLength(0);

    const bundle = await harness.bundle(bundleId);
    expect(bundle.status).toBe('CANCELLED');
    expect(bundle.cancelled_at).not.toBeNull();

    const periods = await harness.billingPeriods(bundleId);
    expect(periods).toHaveLength(1);
    expect(periods[0]?.messages_used).toBe(1);
    expect(await harness.messageCount(userId)).toBe(1);
  });

  it('reports a charge with an unknown outcome instead of retrying it', async () => {
    const { bundleId } = await bundleDueForRenewal();
    gateway.result = 'THROW';

    clock.travelTo(AFTER_PERIOD);
    const first = (await harness.runBilling()).body as unknown as RunReport;
    expect(first.needsReconciliation).toContain(bundleId);

    // A later run must not charge again: the outcome of the first attempt is
    // still unknown, and the claim on that period is still held.
    gateway.result = 'SUCCEEDED';
    const second = (await harness.runBilling()).body as unknown as RunReport;

    expect(second.needsReconciliation).toContain(bundleId);
    expect(second.renewed).toHaveLength(0);
    expect(gateway.charges).toHaveLength(1);
    expect((await harness.bundle(bundleId)).status).toBe('ACTIVE');
  });
});
