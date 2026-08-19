import { Router } from 'express';
import { z } from 'zod';
import type { Controller } from '../../../shared/http/http-result.js';
import { route } from '../../../shared/http/http-result.js';
import type { IdempotencyOptions } from '../../../shared/idempotency/with-idempotency.js';
import { withIdempotency } from '../../../shared/idempotency/with-idempotency.js';
import type { BillingPeriod } from '../domain/billing-period.js';
import type { SubscriptionBundle } from '../domain/subscription-bundle.js';
import type { SubscriptionService } from '../services/subscription.service.js';

const createBody = z.object({
  tier: z.enum(['BASIC', 'PRO', 'ENTERPRISE']),
  billingCycle: z.enum(['MONTHLY', 'YEARLY']),
  autoRenew: z.boolean().default(true),
});

const updateBody = z.object({ autoRenew: z.boolean() });
const idParam = z.string().uuid();

function present(bundle: SubscriptionBundle): Record<string, unknown> {
  const state = bundle.snapshot();
  return {
    id: state.id,
    tier: state.tier,
    billingCycle: state.billingCycle,
    status: state.status,
    maxMessages: state.maxMessages,
    usedMessages: state.usedMessages,
    remaining: bundle.remaining,
    price: { amountCents: state.priceCents, currency: state.currency },
    autoRenew: state.autoRenew,
    cancelAtPeriodEnd: bundle.isCancelling,
    startDate: state.startDate.toISOString(),
    endDate: state.endDate.toISOString(),
    renewalDate: state.renewalDate?.toISOString() ?? null,
    cancelledAt: state.cancelledAt?.toISOString() ?? null,
  };
}

function presentPeriod(period: BillingPeriod): Record<string, unknown> {
  return {
    periodStart: period.periodStart.toISOString(),
    periodEnd: period.periodEnd.toISOString(),
    status: period.status,
    amountCents: period.priceCents,
    currency: period.currency,
    messagesUsed: period.messagesUsed,
    paymentReference: period.paymentReference,
    declineReason: period.declineReason,
    settledAt: period.settledAt?.toISOString() ?? null,
  };
}

export function subscriptionRouter(
  service: SubscriptionService,
  idempotency: IdempotencyOptions,
): Router {
  const create: Controller = async (req) => {
    const command = createBody.parse(req.body);
    const bundle = await service.create({ userId: req.userId, ...command });
    return { status: 201, body: { subscription: present(bundle) } };
  };

  const list: Controller = async (req) => ({
    status: 200,
    body: { subscriptions: (await service.list(req.userId)).map(present) },
  });

  const detail: Controller = async (req) => {
    const { bundle, periods } = await service.detail(req.userId, idParam.parse(req.params['id']));
    return {
      status: 200,
      body: { subscription: present(bundle), billingPeriods: periods.map(presentPeriod) },
    };
  };

  const update: Controller = async (req) => {
    const { autoRenew } = updateBody.parse(req.body);
    const bundle = await service.setAutoRenew(
      req.userId,
      idParam.parse(req.params['id']),
      autoRenew,
    );
    return { status: 200, body: { subscription: present(bundle) } };
  };

  const cancel: Controller = async (req) => {
    const bundle = await service.cancel(req.userId, idParam.parse(req.params['id']));
    return { status: 200, body: { subscription: present(bundle) } };
  };

  return Router()
    .post('/', route(withIdempotency(idempotency, create)))
    .get('/', route(list))
    .get('/:id', route(detail))
    .patch('/:id', route(update))
    .post('/:id/cancel', route(withIdempotency(idempotency, cancel)));
}
