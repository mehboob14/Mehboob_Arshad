-- A bundle is created before its first payment settles, and a cancelled bundle
-- keeps serving until the end of the period the user already paid for. Both
-- states were unrepresentable under the original constraints.
ALTER TABLE subscription_bundles
  DROP CONSTRAINT IF EXISTS subscription_bundles_status_check,
  DROP CONSTRAINT IF EXISTS bundle_cancelled_at_set;

ALTER TABLE subscription_bundles
  ADD CONSTRAINT bundle_status_known CHECK (
    status IN ('PENDING_PAYMENT', 'ACTIVE', 'PAYMENT_FAILED', 'CANCELLED', 'EXPIRED')
  ),
  -- Cancelling implies a timestamp, but a timestamp no longer implies the
  -- terminal state: a bundle can be cancelled and still serving.
  ADD CONSTRAINT bundle_cancelled_has_timestamp CHECK (
    status <> 'CANCELLED' OR cancelled_at IS NOT NULL
  ),
  ADD CONSTRAINT bundle_cancelled_does_not_renew CHECK (
    cancelled_at IS NULL OR auto_renew = FALSE
  );

-- Finding what is due is the billing run's only scan, so it gets its own index.
CREATE INDEX subscription_bundles_due_idx
  ON subscription_bundles (end_date)
  WHERE status = 'ACTIVE';

-- One row per period a bundle has been billed for. It serves two purposes that
-- happen to need the same record:
--
--   1. Usage history. A renewal resets the bundle's counter, so the closing
--      balance of each period is snapshotted here and survives renewal,
--      cancellation and expiry.
--   2. Payment safety. UNIQUE (bundle_id, period_start) is what stops a retried
--      or concurrent billing run from charging the same period twice. The row is
--      claimed before the gateway is called, exactly as an idempotency key is.
CREATE TABLE subscription_billing_periods (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id         UUID NOT NULL REFERENCES subscription_bundles (id) ON DELETE CASCADE,
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,
  price_cents       INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',

  status            TEXT NOT NULL CHECK (status IN ('PENDING', 'PAID', 'FAILED')),
  payment_reference TEXT,
  decline_reason    TEXT,

  messages_used     INTEGER NOT NULL DEFAULT 0,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at        TIMESTAMPTZ,

  CONSTRAINT billing_period_once_per_start UNIQUE (bundle_id, period_start),
  CONSTRAINT billing_period_ordered CHECK (period_end > period_start),
  CONSTRAINT billing_period_settled_has_outcome CHECK (
    (status = 'PENDING') = (settled_at IS NULL)
  )
);

CREATE INDEX subscription_billing_periods_bundle_idx
  ON subscription_billing_periods (bundle_id, period_start DESC);
