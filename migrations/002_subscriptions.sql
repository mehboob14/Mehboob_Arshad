CREATE TABLE subscription_bundles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tier           TEXT NOT NULL CHECK (tier IN ('BASIC', 'PRO', 'ENTERPRISE')),
  billing_cycle  TEXT NOT NULL CHECK (billing_cycle IN ('MONTHLY', 'YEARLY')),
  status         TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CANCELLED', 'PAYMENT_FAILED', 'EXPIRED')),

  -- NULL encodes "unlimited" (Enterprise). Modelled as absence of a limit rather
  -- than a sentinel number so no arithmetic can accidentally exhaust it.
  max_messages   INTEGER,
  used_messages  INTEGER NOT NULL DEFAULT 0,

  price_cents    INTEGER NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  auto_renew     BOOLEAN NOT NULL DEFAULT TRUE,

  start_date     TIMESTAMPTZ NOT NULL,
  end_date       TIMESTAMPTZ NOT NULL,
  renewal_date   TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The application never trusts itself with the balance: over-consumption is
  -- rejected by the database even if a code path forgets to check.
  CONSTRAINT bundle_usage_non_negative CHECK (used_messages >= 0),
  CONSTRAINT bundle_usage_within_limit CHECK (max_messages IS NULL OR used_messages <= max_messages),
  CONSTRAINT bundle_limit_positive CHECK (max_messages IS NULL OR max_messages > 0),
  CONSTRAINT bundle_period_ordered CHECK (end_date > start_date),
  CONSTRAINT bundle_cancelled_at_set CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);

CREATE INDEX subscription_bundles_active_idx
  ON subscription_bundles (user_id, status, end_date);

-- Free tier is granted per calendar month. A month "resets" because a new
-- period key produces a new row: there is no scheduled job to reset counters,
-- and no window in which a reset can be missed, run twice, or run late.
CREATE TABLE free_allowance_periods (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  period  TEXT NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  granted INTEGER NOT NULL,
  used    INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (user_id, period),
  CONSTRAINT free_usage_within_grant CHECK (used >= 0 AND used <= granted)
);
