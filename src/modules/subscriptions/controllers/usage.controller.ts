import { Router } from 'express';
import type { Clock } from '../../../shared/domain/clock.js';
import type { Controller } from '../../../shared/http/http-result.js';
import { route } from '../../../shared/http/http-result.js';
import type { EntitlementService } from '../services/entitlement.service.js';

export function usageRouter(entitlements: EntitlementService, clock: Clock): Router {
  const summary: Controller = async (req) => ({
    status: 200,
    body: await entitlements.summarise(req.userId, clock.now()),
  });

  return Router().get('/', route(summary));
}
