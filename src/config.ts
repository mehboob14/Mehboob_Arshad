import { existsSync } from 'node:fs';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  AI_LATENCY_MIN_MS: z.coerce.number().int().nonnegative().default(200),
  AI_LATENCY_MAX_MS: z.coerce.number().int().nonnegative().default(800),
  FREE_MESSAGES_PER_MONTH: z.coerce.number().int().nonnegative().default(3),
  IDEMPOTENCY_CLAIM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  PAYMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.2),
  BILLING_STALE_PERIOD_MS: z.coerce.number().int().positive().default(300_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && existsSync('.env')) process.loadEnvFile('.env');

  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  if (parsed.data.AI_LATENCY_MAX_MS < parsed.data.AI_LATENCY_MIN_MS) {
    throw new Error('AI_LATENCY_MAX_MS must be >= AI_LATENCY_MIN_MS');
  }
  return parsed.data;
}
