import { loadConfig } from '../src/config.js';
import { tierDefinition } from '../src/modules/subscriptions/domain/tier.js';
import type { BillingCycle, Tier } from '../src/modules/subscriptions/domain/tier.js';
import { CalendarMonth } from '../src/shared/domain/calendar-month.js';
import { migrate } from '../src/shared/persistence/migrate.js';
import { PostgresDatabase } from '../src/shared/persistence/postgres.js';

interface SeedBundle {
  tier: Tier;
  billingCycle: BillingCycle;
  usedMessages: number;
}

interface SeedUser {
  id: string;
  email: string;
  note: string;
  bundles: SeedBundle[];
}

/** Fixed ids so the README can be copied and pasted straight into a request. */
const USERS: SeedUser[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'free@example.com',
    note: 'free tier only',
    bundles: [],
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    email: 'basic@example.com',
    note: 'Basic bundle, 1 message left',
    bundles: [{ tier: 'BASIC', billingCycle: 'MONTHLY', usedMessages: 9 }],
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    email: 'stacked@example.com',
    note: 'Basic + Pro, to demonstrate bundle selection',
    bundles: [
      { tier: 'BASIC', billingCycle: 'MONTHLY', usedMessages: 2 },
      { tier: 'PRO', billingCycle: 'YEARLY', usedMessages: 40 },
    ],
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    email: 'enterprise@example.com',
    note: 'Enterprise (unlimited) alongside a Basic bundle',
    bundles: [
      { tier: 'BASIC', billingCycle: 'MONTHLY', usedMessages: 0 },
      { tier: 'ENTERPRISE', billingCycle: 'YEARLY', usedMessages: 0 },
    ],
  },
];

const config = loadConfig();
const db = new PostgresDatabase(config.DATABASE_URL);
await migrate(db);

const now = new Date();
const startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);

await db.withTransaction(async (uow) => {
  await uow.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [USERS.map((u) => u.id)]);

  for (const user of USERS) {
    await uow.query('INSERT INTO users (id, email) VALUES ($1, $2)', [user.id, user.email]);

    for (const bundle of user.bundles) {
      const definition = tierDefinition(bundle.tier);
      const months = bundle.billingCycle === 'YEARLY' ? 12 : 1;
      const endDate = new Date(startDate);
      endDate.setUTCMonth(endDate.getUTCMonth() + months);

      const [row] = await uow.query<{ id: string }>(
        `INSERT INTO subscription_bundles
           (user_id, tier, billing_cycle, status, max_messages, used_messages,
            price_cents, auto_renew, start_date, end_date, renewal_date)
         VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $6, TRUE, $7, $8, $8)
         RETURNING id`,
        [
          user.id,
          bundle.tier,
          bundle.billingCycle,
          definition.maxMessages,
          bundle.usedMessages,
          definition.priceCents[bundle.billingCycle],
          startDate,
          endDate,
        ],
      );

      // The bundle is seeded as already paid for, so its first billing period
      // exists and the usage history endpoint has something to show.
      await uow.query(
        `INSERT INTO subscription_billing_periods
           (bundle_id, period_start, period_end, price_cents, status, messages_used, settled_at)
         VALUES ($1, $2, $3, $4, 'PAID', $5, now())`,
        [
          row?.id,
          startDate,
          endDate,
          definition.priceCents[bundle.billingCycle],
          bundle.usedMessages,
        ],
      );
    }

    // A user who holds a bundle starts with the free grant already spent, so the
    // demo requests in api.http exercise the bundle they were written to show
    // rather than silently drawing on the free tier for the first three clicks.
    if (user.bundles.length > 0) {
      await uow.query(
        `INSERT INTO free_allowance_periods (user_id, period, granted, used)
         VALUES ($1, $2, $3, $3)`,
        [user.id, CalendarMonth.from(now).key, config.FREE_MESSAGES_PER_MONTH],
      );
    }
  }
});

for (const user of USERS) {
  process.stdout.write(`${user.id}  ${user.email.padEnd(24)} ${user.note}\n`);
}

await db.close();
