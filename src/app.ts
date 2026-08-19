import express, { type Express } from 'express';
import type { Container } from './container.js';
import { chatRouter } from './modules/chat/controllers/chat.controller.js';
import { billingRouter } from './modules/subscriptions/controllers/billing.controller.js';
import { subscriptionRouter } from './modules/subscriptions/controllers/subscription.controller.js';
import { usageRouter } from './modules/subscriptions/controllers/usage.controller.js';
import { NotFoundError } from './shared/domain/errors.js';
import { authenticate } from './shared/http/authenticate.js';
import { errorHandler } from './shared/http/error-handler.js';

export function createApp(container: Container): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/v1/chat', authenticate, chatRouter(container.chat, container.idempotency));
  app.use('/api/v1/usage', authenticate, usageRouter(container.entitlements, container.clock));
  app.use(
    '/api/v1/subscriptions',
    authenticate,
    subscriptionRouter(container.subscriptions, container.idempotency),
  );

  // Operational, not per-user: this stands in for the scheduler that would run
  // the billing cycle. It carries no user identity and so no authenticate step.
  app.use('/api/v1/billing', billingRouter(container.billing));

  app.use((req) => {
    throw new NotFoundError(`No route matches ${req.method} ${req.path}.`);
  });

  // Express 5 forwards rejected promises from handlers, so controllers need no
  // per-route try/catch and every failure is translated in exactly one place.
  // Tests deliberately provoke 5xx paths, so their output stays readable.
  app.use(
    errorHandler((error) => {
      if (container.config.NODE_ENV !== 'test') console.error(error);
    }),
  );

  return app;
}
