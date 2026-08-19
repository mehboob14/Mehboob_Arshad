import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../../src/shared/domain/clock.js';
import { Harness } from './harness.js';

const NO_LATENCY = { AI_LATENCY_MIN_MS: 0, AI_LATENCY_MAX_MS: 0 };

describe('message quota', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await Harness.start({ config: NO_LATENCY });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('grants the configured number of free messages, then refuses', async () => {
    const userId = await harness.createUser();

    for (let i = 0; i < 3; i++) {
      const response = await harness.ask({ userId, question: `question ${i}` });
      expect(response.status).toBe(201);
    }

    const refused = await harness.ask({ userId, question: 'one too many' });
    expect(refused.status).toBe(402);

    const error = refused.body['error'] as { code: string; details: Record<string, unknown> };
    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.details['freeRemaining']).toBe(0);
    expect(error.details['freeResetsAt']).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  });

  it('falls through to a bundle when the free grant is spent', async () => {
    const userId = await harness.createUser();
    const bundleId = await harness.giveBundle(userId, { tier: 'BASIC' });

    for (let i = 0; i < 4; i++) {
      expect((await harness.ask({ userId, question: `q${i}` })).status).toBe(201);
    }

    expect(await harness.bundleUsage(bundleId)).toBe(1);
  });

  it('never lets concurrent requests spend the same last credit', async () => {
    const userId = await harness.createUser();
    const bundleId = await harness.giveBundle(userId, { tier: 'BASIC', usedMessages: 9 });

    // Free grant first, so the contended balance is the bundle's final message.
    for (let i = 0; i < 3; i++) await harness.ask({ userId, question: `warmup ${i}` });

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => harness.ask({ userId, question: `race ${i}` })),
    );

    const accepted = responses.filter((r) => r.status === 201);
    const refused = responses.filter((r) => r.status === 402);

    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(7);
    expect(await harness.bundleUsage(bundleId)).toBe(10);
  });

  it('never lets concurrent requests overdraw the free grant', async () => {
    const single = await Harness.start({
      config: { ...NO_LATENCY, FREE_MESSAGES_PER_MONTH: 1 },
    });
    try {
      const userId = await single.createUser();

      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, i) => single.ask({ userId, question: `race ${i}` })),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await single.messageCount(userId)).toBe(1);
    } finally {
      await single.stop();
    }
  });

  it('resets the free grant when the calendar month turns over', async () => {
    const clock = new FixedClock(new Date('2026-08-31T23:59:00Z'));
    const august = await Harness.start({ config: NO_LATENCY, clock });
    try {
      const userId = await august.createUser();

      for (let i = 0; i < 3; i++) {
        expect((await august.ask({ userId, question: `august ${i}` })).status).toBe(201);
      }
      expect((await august.ask({ userId, question: 'august overflow' })).status).toBe(402);

      clock.travelTo(new Date('2026-09-01T00:00:00Z'));

      expect((await august.ask({ userId, question: 'september' })).status).toBe(201);
      expect(await august.freeUsage(userId, '2026-08')).toBe(3);
      expect(await august.freeUsage(userId, '2026-09')).toBe(1);
    } finally {
      await august.stop();
    }
  });

  it('prefers the bundle with the greatest remaining balance', async () => {
    const userId = await harness.createUser();
    const basic = await harness.giveBundle(userId, { tier: 'BASIC' });
    const pro = await harness.giveBundle(userId, { tier: 'PRO', usedMessages: 50 });

    for (let i = 0; i < 4; i++) await harness.ask({ userId, question: `q${i}` });

    expect(await harness.bundleUsage(pro)).toBe(51);
    expect(await harness.bundleUsage(basic)).toBe(0);
  });

  it('keeps an unlimited bundle in reserve until metered credit runs out', async () => {
    const userId = await harness.createUser();
    const basic = await harness.giveBundle(userId, { tier: 'BASIC', usedMessages: 9 });
    const enterprise = await harness.giveBundle(userId, { tier: 'ENTERPRISE' });

    for (let i = 0; i < 3; i++) await harness.ask({ userId, question: `free ${i}` });

    expect((await harness.ask({ userId, question: 'spends the last basic' })).status).toBe(201);
    expect(await harness.bundleUsage(basic)).toBe(10);

    const overflow = await harness.ask({ userId, question: 'now unlimited' });
    expect(overflow.status).toBe(201);
    expect((overflow.body['allowance'] as { remaining: number | null }).remaining).toBeNull();
    expect(await harness.bundleUsage(enterprise)).toBe(1);
  });

  it('reports the remaining balance on the usage endpoint', async () => {
    const userId = await harness.createUser();
    await harness.giveBundle(userId, { tier: 'BASIC' });
    await harness.ask({ userId, question: 'hello' });

    const usage = await harness.request('GET', '/api/v1/usage', { userId });

    expect(usage.status).toBe(200);
    expect(usage.body['free']).toMatchObject({ granted: 3, used: 1, remaining: 2 });
    expect(usage.body['totalRemaining']).toBe(12);
  });

  it('rejects an unreadable body as a client error, not a server fault', async () => {
    const userId = await harness.createUser();

    // Truncated JSON, and a body over the 256kb limit. Both used to surface as
    // 500 INTERNAL_ERROR: the size guard was invisible to clients, a client bug
    // was indistinguishable from an outage, and any caller could drive the 5xx
    // rate and fill the log with stack traces using malformed input alone.
    const truncated = await harness.postRaw('/api/v1/chat/messages', userId, '{"question": "hi"');
    const oversized = await harness.postRaw(
      '/api/v1/chat/messages',
      userId,
      JSON.stringify({ question: 'x'.repeat(300_000) }),
    );

    expect(truncated.status).toBe(400);
    expect(oversized.status).toBe(413);
    for (const response of [truncated, oversized]) {
      expect((response.body['error'] as { code: string }).code).toBe('VALIDATION_FAILED');
    }
  });
});
