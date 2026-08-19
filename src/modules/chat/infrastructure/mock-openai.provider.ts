import { setTimeout as delay } from 'node:timers/promises';
import type { AiChatProvider, AiCompletion } from '../domain/ports.js';

export interface LatencyProfile {
  readonly minMs: number;
  readonly maxMs: number;
}

/** OpenAI's own rule of thumb: roughly four characters of English per token. */
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * Stands in for the OpenAI Chat Completions API. The only behaviour worth
 * simulating for this exercise is its latency, because that is what forces the
 * call out of the transaction that reserves quota, and what makes a client
 * retry — and therefore idempotency — realistic rather than theoretical.
 */
export class MockOpenAiProvider implements AiChatProvider {
  constructor(
    private readonly latency: LatencyProfile,
    private readonly random: () => number = Math.random,
  ) {}

  async complete(question: string): Promise<AiCompletion> {
    await delay(this.nextLatencyMs());

    const answer =
      `Mocked completion for: "${question.slice(0, 120)}". ` +
      'No request was sent to OpenAI; this response is generated locally.';

    const promptTokens = estimateTokens(question);
    const completionTokens = estimateTokens(answer);

    return {
      answer,
      tokens: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    };
  }

  private nextLatencyMs(): number {
    const { minMs, maxMs } = this.latency;
    return Math.round(minMs + this.random() * (maxMs - minMs));
  }
}
