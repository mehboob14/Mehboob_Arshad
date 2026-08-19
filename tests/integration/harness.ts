import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { loadConfig } from '../../src/config.js';
import type { Container, ContainerOverrides } from '../../src/container.js';
import { createContainer } from '../../src/container.js';
import type {
  PaymentGateway,
  PaymentRequest,
  PaymentResult,
} from '../../src/modules/subscriptions/domain/payment.js';
import type { BillingCycle, Tier } from '../../src/modules/subscriptions/domain/tier.js';
import { tierDefinition } from '../../src/modules/subscriptions/domain/tier.js';
import { migrate } from '../../src/shared/persistence/migrate.js';

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

export interface RequestOptions {
  userId?: string;
  body?: unknown;
  idempotencyKey?: string;
}

/** Records every charge, so a test can assert that a retry did not make two. */
export class RecordingGateway implements PaymentGateway {
  readonly charges: PaymentRequest[] = [];

  constructor(private outcome: 'SUCCEEDED' | 'DECLINED' | 'THROW' = 'SUCCEEDED') {}

  set result(outcome: 'SUCCEEDED' | 'DECLINED' | 'THROW') {
    this.outcome = outcome;
  }

  charge(request: PaymentRequest): Promise<PaymentResult> {
    this.charges.push(request);
    if (this.outcome === 'THROW') return Promise.reject(new Error('gateway timeout'));
    return Promise.resolve(
      this.outcome === 'SUCCEEDED'
        ? { outcome: 'SUCCEEDED', reference: request.reference }
        : { outcome: 'DECLINED', reason: 'card_declined' },
    );
  }
}

function required<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`expected a ${what} row`);
  return row;
}

const TABLES = [
  'chat_messages',
  'idempotency_keys',
  'subscription_billing_periods',
  'subscription_bundles',
  'free_allowance_periods',
  'users',
];

export class Harness {
  private constructor(
    readonly container: Container,
    private readonly server: Server,
    private readonly baseUrl: string,
  ) {}

  static async start(
    options: { config?: Partial<Config> } & ContainerOverrides = {},
  ): Promise<Harness> {
    const { config: configOverrides, ...containerOverrides } = options;
    const config: Config = { ...loadConfig(), ...configOverrides };
    const container = createContainer(config, containerOverrides);

    await migrate(container.database);
    await container.database.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);

    const server = await new Promise<Server>((resolve) => {
      const listening = createApp(container).listen(0, () => {
        resolve(listening);
      });
    });
    const { port } = server.address() as AddressInfo;

    return new Harness(container, server, `http://127.0.0.1:${port}`);
  }

  async createUser(email = `${crypto.randomUUID()}@example.com`): Promise<string> {
    const [row] = await this.container.database.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id',
      [email],
    );
    return required(row, 'user').id;
  }

  /** Inserts an already-paid bundle directly, for tests about consumption rather than purchase. */
  async giveBundle(
    userId: string,
    options: {
      tier: Tier;
      usedMessages?: number;
      billingCycle?: BillingCycle;
      autoRenew?: boolean;
      startDate?: Date;
      endDate?: Date;
    },
  ): Promise<string> {
    const cycle = options.billingCycle ?? 'MONTHLY';
    const definition = tierDefinition(options.tier);
    const start = options.startDate ?? new Date(Date.now() - 86_400_000);
    const end = options.endDate ?? new Date(Date.now() + 30 * 86_400_000);

    const [row] = await this.container.database.query<{ id: string }>(
      `INSERT INTO subscription_bundles
         (user_id, tier, billing_cycle, status, max_messages, used_messages,
          price_cents, auto_renew, start_date, end_date, renewal_date)
       VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $6, $7, $8, $9, $9)
       RETURNING id`,
      [
        userId,
        options.tier,
        cycle,
        definition.maxMessages,
        options.usedMessages ?? 0,
        definition.priceCents[cycle],
        options.autoRenew ?? true,
        start,
        end,
      ],
    );
    const bundleId = required(row, 'bundle').id;

    await this.container.database.query(
      `INSERT INTO subscription_billing_periods
         (bundle_id, period_start, period_end, price_cents, status, settled_at)
       VALUES ($1, $2, $3, $4, 'PAID', now())`,
      [bundleId, start, end, definition.priceCents[cycle]],
    );
    return bundleId;
  }

  ask(options: RequestOptions & { question: string }): Promise<ApiResponse> {
    const { question, ...rest } = options;
    return this.request('POST', '/api/v1/chat/messages', { ...rest, body: { question } });
  }

  runBilling(): Promise<ApiResponse> {
    return this.request('POST', '/api/v1/billing/run', { body: {} });
  }

  async request(method: string, path: string, options: RequestOptions): Promise<ApiResponse> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.userId) headers['x-user-id'] = options.userId;
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();

    return {
      status: response.status,
      headers: response.headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  }

  /** Sends a body the JSON parser will reject, or one over the size limit. */
  async postRaw(path: string, userId: string, body: string): Promise<ApiResponse> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': userId },
      body,
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  }

  async bundle(bundleId: string): Promise<{
    status: string;
    used_messages: number;
    auto_renew: boolean;
    start_date: Date;
    end_date: Date;
    cancelled_at: Date | null;
  }> {
    const [row] = await this.container.database.query<{
      status: string;
      used_messages: number;
      auto_renew: boolean;
      start_date: Date;
      end_date: Date;
      cancelled_at: Date | null;
    }>(
      `SELECT status, used_messages, auto_renew, start_date, end_date, cancelled_at
         FROM subscription_bundles WHERE id = $1`,
      [bundleId],
    );
    return required(row, 'bundle');
  }

  billingPeriods(
    bundleId: string,
  ): Promise<{ status: string; messages_used: number; period_start: Date }[]> {
    return this.container.database.query(
      `SELECT status, messages_used, period_start
         FROM subscription_billing_periods WHERE bundle_id = $1 ORDER BY period_start`,
      [bundleId],
    );
  }

  async bundleUsage(bundleId: string): Promise<number> {
    return (await this.bundle(bundleId)).used_messages;
  }

  async freeUsage(userId: string, period: string): Promise<number> {
    const [row] = await this.container.database.query<{ used: number }>(
      'SELECT used FROM free_allowance_periods WHERE user_id = $1 AND period = $2',
      [userId, period],
    );
    return row?.used ?? 0;
  }

  async messageCount(userId: string, status?: string): Promise<number> {
    const [row] = await this.container.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM chat_messages
        WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)`,
      [userId, status ?? null],
    );
    return required(row, 'count').count;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
    await this.container.database.close();
  }
}
