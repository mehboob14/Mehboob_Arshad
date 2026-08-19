import { Router } from 'express';
import { z } from 'zod';
import type { IdempotencyOptions } from '../../../shared/idempotency/with-idempotency.js';
import { withIdempotency } from '../../../shared/idempotency/with-idempotency.js';
import type { Controller } from '../../../shared/http/http-result.js';
import { route } from '../../../shared/http/http-result.js';
import type { ChatMessageState } from '../domain/chat-message.js';
import type { ChatService } from '../services/chat.service.js';

const askBody = z.object({
  question: z.string().trim().min(1, 'A question is required.').max(4000),
});

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.coerce.date().optional(),
});

function present(message: ChatMessageState): Record<string, unknown> {
  return {
    id: message.id,
    question: message.question,
    answer: message.answer,
    status: message.status,
    tokens: message.tokens && {
      prompt: message.tokens.promptTokens,
      completion: message.tokens.completionTokens,
      total: message.tokens.totalTokens,
    },
    chargedTo: { ...message.charge, refunded: message.chargeRefunded },
    createdAt: message.createdAt.toISOString(),
    completedAt: message.completedAt?.toISOString() ?? null,
  };
}

export function chatRouter(service: ChatService, idempotency: IdempotencyOptions): Router {
  const ask: Controller = async (req) => {
    const { question } = askBody.parse(req.body);
    const result = await service.ask({ userId: req.userId, question });
    return {
      status: 201,
      body: { message: present(result.message), allowance: { remaining: result.remaining } },
    };
  };

  const history: Controller = async (req) => {
    const { limit, before } = historyQuery.parse(req.query);
    const messages = await service.history(req.userId, { limit, ...(before ? { before } : {}) });
    return { status: 200, body: { messages: messages.map(present), limit } };
  };

  return Router()
    .post('/messages', route(withIdempotency(idempotency, ask)))
    .get('/messages', route(history));
}
