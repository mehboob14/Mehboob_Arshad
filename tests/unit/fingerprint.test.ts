import { describe, expect, it } from 'vitest';
import { fingerprintRequest } from '../../src/shared/idempotency/idempotency.js';

const base = { method: 'POST', path: '/api/v1/chat/messages', userId: 'user-1' };

describe('fingerprintRequest', () => {
  it('is stable across key ordering, so a reordered payload is still a retry', () => {
    const a = fingerprintRequest({ ...base, body: { question: 'hi', model: 'x' } });
    const b = fingerprintRequest({ ...base, body: { model: 'x', question: 'hi' } });

    expect(a).toBe(b);
  });

  it('changes when the payload changes, so key reuse is detectable', () => {
    const a = fingerprintRequest({ ...base, body: { question: 'hi' } });
    const b = fingerprintRequest({ ...base, body: { question: 'hello' } });

    expect(a).not.toBe(b);
  });

  it('changes when the caller changes, so a key cannot be replayed across users', () => {
    const a = fingerprintRequest({ ...base, body: { question: 'hi' } });
    const b = fingerprintRequest({ ...base, userId: 'user-2', body: { question: 'hi' } });

    expect(a).not.toBe(b);
  });
});
