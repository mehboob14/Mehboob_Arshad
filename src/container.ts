import type { Config } from './config.js';
import type { AiChatProvider } from './modules/chat/domain/ports.js';
import { MockOpenAiProvider } from './modules/chat/infrastructure/mock-openai.provider.js';
import { PostgresChatMessageRepository } from './modules/chat/repositories/chat-message.repository.postgres.js';
import { ChatService } from './modules/chat/services/chat.service.js';
import type { PaymentGateway } from './modules/subscriptions/domain/payment.js';
import { SimulatedPaymentGateway } from './modules/subscriptions/infrastructure/simulated-payment.gateway.js';
import { PostgresBillingPeriodRepository } from './modules/subscriptions/repositories/billing-period.repository.postgres.js';
import { PostgresEntitlementRepository } from './modules/subscriptions/repositories/entitlement.repository.postgres.js';
import { PostgresSubscriptionRepository } from './modules/subscriptions/repositories/subscription.repository.postgres.js';
import { BillingService } from './modules/subscriptions/services/billing.service.js';
import { EntitlementService } from './modules/subscriptions/services/entitlement.service.js';
import { SubscriptionService } from './modules/subscriptions/services/subscription.service.js';
import type { Clock } from './shared/domain/clock.js';
import { systemClock } from './shared/domain/clock.js';
import { PostgresIdempotencyStore } from './shared/idempotency/idempotency-store.postgres.js';
import type { IdempotencyOptions } from './shared/idempotency/with-idempotency.js';
import { PostgresDatabase } from './shared/persistence/postgres.js';

export interface Container {
  readonly config: Config;
  readonly clock: Clock;
  readonly database: PostgresDatabase;
  readonly chat: ChatService;
  readonly entitlements: EntitlementService;
  readonly subscriptions: SubscriptionService;
  readonly billing: BillingService;
  readonly idempotency: IdempotencyOptions;
}

export interface ContainerOverrides {
  readonly clock?: Clock;
  readonly aiProvider?: AiChatProvider;
  readonly paymentGateway?: PaymentGateway;
}

/**
 * The composition root: the single place that knows which implementation
 * satisfies which port. Every other file depends on interfaces only, which is
 * what lets a test swap the clock, the AI provider or the payment gateway
 * without a mocking framework and without touching the code under test.
 */
export function createContainer(config: Config, overrides: ContainerOverrides = {}): Container {
  const clock = overrides.clock ?? systemClock;
  const database = new PostgresDatabase(config.DATABASE_URL);

  const subscriptionRepository = new PostgresSubscriptionRepository(database);
  const billingPeriodRepository = new PostgresBillingPeriodRepository(database);
  const paymentGateway =
    overrides.paymentGateway ?? new SimulatedPaymentGateway(config.PAYMENT_FAILURE_RATE);

  const entitlements = new EntitlementService(
    new PostgresEntitlementRepository(database),
    config.FREE_MESSAGES_PER_MONTH,
  );

  const chat = new ChatService(
    database,
    new PostgresChatMessageRepository(database),
    entitlements,
    overrides.aiProvider ??
      new MockOpenAiProvider({
        minMs: config.AI_LATENCY_MIN_MS,
        maxMs: config.AI_LATENCY_MAX_MS,
      }),
    clock,
  );

  const subscriptions = new SubscriptionService(
    database,
    subscriptionRepository,
    billingPeriodRepository,
    paymentGateway,
    clock,
  );

  const billing = new BillingService(
    database,
    subscriptionRepository,
    billingPeriodRepository,
    paymentGateway,
    clock,
    config.BILLING_STALE_PERIOD_MS,
  );

  return {
    config,
    clock,
    database,
    chat,
    entitlements,
    subscriptions,
    billing,
    idempotency: {
      store: new PostgresIdempotencyStore(database),
      clock,
      claimTimeoutMs: config.IDEMPOTENCY_CLAIM_TIMEOUT_MS,
    },
  };
}
