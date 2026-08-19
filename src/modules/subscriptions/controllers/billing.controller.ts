import { Router } from 'express';
import { z } from 'zod';
import type { Controller } from '../../../shared/http/http-result.js';
import { route } from '../../../shared/http/http-result.js';
import type { BillingService } from '../services/billing.service.js';

const runBody = z.object({ limit: z.number().int().min(1).max(1000).default(100) });

/**
 * In production this is a scheduled job, not a route. It is exposed so the
 * renewal, decline and cancellation behaviour can be demonstrated and tested
 * without waiting a month, and it is deliberately safe to call repeatedly:
 * each billing period can only be claimed once, so a second run is a no-op.
 */
export function billingRouter(billing: BillingService): Router {
  const run: Controller = async (req) => {
    const { limit } = runBody.parse(req.body ?? {});
    return { status: 200, body: await billing.run(limit) };
  };

  return Router().post('/run', route(run));
}
