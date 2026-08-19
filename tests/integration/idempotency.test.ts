import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiChatProvider, AiCompletion } from '../../src/modules/chat/domain/ports.js';
import { Harness } from './harness.js';

const NO_LATENCY = { AI_LATENCY_MIN_MS: 0, AI_LATENCY_MAX_MS: 0 };

class ScriptedProvider implements AiChatProvider {
  calls = 0;

  constructor(private readonly failuresBeforeSuccess: number) {}

  complete(question: string): Promise<AiCompletion> {
    this.calls += 1;
    if (this.calls <= this.failuresBeforeSuccess) {
      return Promise.reject(new Error('provider unavailable'));
    }
    return Promise.resolve({
      answer: `answer to ${question}`,
      tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
  }
}

describe('idempotent message submission', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await Harness.start({ config: NO_LATENCY });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('replays the recorded response instead of charging a second time', async () => {
    const userId = await harness.createUser();
    const idempotencyKey = 'retry-after-timeout';

    const first = await harness.ask({ userId, question: 'what is DDD?', idempotencyKey });
    const second = await harness.ask({ userId, question: 'what is DDD?', idempotencyKey });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get('idempotency-replayed')).toBe('true');

    expect(await harness.messageCount(userId)).toBe(1);
    expect(await harness.freeUsage(userId, currentPeriod())).toBe(1);
  });

  it('rejects a key that is reused for a different request', async () => {
    const userId = await harness.createUser();
    const idempotencyKey = 'reused-key';

    await harness.ask({ userId, question: 'first question', idempotencyKey });
    const reused = await harness.ask({ userId, question: 'different question', idempotencyKey });

    expect(reused.status).toBe(422);
    expect((reused.body['error'] as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await harness.messageCount(userId)).toBe(1);
  });

  it('scopes keys to a user, so two callers cannot collide', async () => {
    const first = await harness.createUser();
    const second = await harness.createUser();

    const a = await harness.ask({ userId: first, question: 'hello', idempotencyKey: 'shared' });
    const b = await harness.ask({ userId: second, question: 'hello', idempotencyKey: 'shared' });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body).not.toEqual(b.body);
  });

  it('records a refusal, so a replay sees the same refusal', async () => {
    const userId = await harness.createUser();
    for (let i = 0; i < 3; i++) await harness.ask({ userId, question: `free ${i}` });

    const refused = await harness.ask({ userId, question: 'over', idempotencyKey: 'over-quota' });
    const replayed = await harness.ask({ userId, question: 'over', idempotencyKey: 'over-quota' });

    expect(refused.status).toBe(402);
    expect(replayed.status).toBe(402);
    expect(replayed.body).toEqual(refused.body);
    expect(replayed.headers.get('idempotency-replayed')).toBe('true');
  });

  it('refuses a duplicate that arrives while the original is still in flight', async () => {
    const slow = await Harness.start({
      config: { AI_LATENCY_MIN_MS: 400, AI_LATENCY_MAX_MS: 400 },
    });
    try {
      const userId = await slow.createUser();
      const idempotencyKey = 'double-click';

      const [a, b] = await Promise.all([
        slow.ask({ userId, question: 'submitted twice', idempotencyKey }),
        slow.ask({ userId, question: 'submitted twice', idempotencyKey }),
      ]);

      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses).toEqual([201, 409]);
      expect(await slow.messageCount(userId)).toBe(1);
      expect(await slow.freeUsage(userId, currentPeriod())).toBe(1);
    } finally {
      await slow.stop();
    }
  });

  it('refunds the charge when the provider fails, and lets the same key retry', async () => {
    const provider = new ScriptedProvider(1);
    const flaky = await Harness.start({ config: NO_LATENCY, aiProvider: provider });
    try {
      const userId = await flaky.createUser();
      const idempotencyKey = 'provider-blip';

      const failed = await flaky.ask({ userId, question: 'will fail once', idempotencyKey });
      expect(failed.status).toBe(503);
      expect(await flaky.freeUsage(userId, currentPeriod())).toBe(0);
      expect(await flaky.messageCount(userId, 'FAILED')).toBe(1);

      const retried = await flaky.ask({ userId, question: 'will fail once', idempotencyKey });
      expect(retried.status).toBe(201);
      expect(await flaky.freeUsage(userId, currentPeriod())).toBe(1);
      expect(provider.calls).toBe(2);
    } finally {
      await flaky.stop();
    }
  });
});

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${(now.getUTCMonth() + 1).toString().padStart(2, '0')}`;
}
