-- PostgreSQL stores timestamptz to microsecond precision; a JavaScript Date
-- carries milliseconds. Any value the database generated therefore lost its
-- last three digits on the way into the application, and a query that matched
-- a row by timestamp equality silently found nothing.
--
-- The failure was quiet rather than loud: a renewal still charged and still
-- rolled the period, but the closing usage snapshot never landed, so usage
-- history was lost without an error anywhere.
--
-- Pinning every timestamp to millisecond precision makes the two sides agree
-- by construction. The column type now enforces what the application already
-- assumed, so the mismatch cannot be reintroduced by a data fix, a migration
-- using now(), or a future DEFAULT.

ALTER TABLE users
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3);

ALTER TABLE subscription_bundles
  ALTER COLUMN start_date   TYPE TIMESTAMPTZ(3),
  ALTER COLUMN end_date     TYPE TIMESTAMPTZ(3),
  ALTER COLUMN renewal_date TYPE TIMESTAMPTZ(3),
  ALTER COLUMN cancelled_at TYPE TIMESTAMPTZ(3),
  ALTER COLUMN created_at   TYPE TIMESTAMPTZ(3);

ALTER TABLE subscription_billing_periods
  ALTER COLUMN period_start TYPE TIMESTAMPTZ(3),
  ALTER COLUMN period_end   TYPE TIMESTAMPTZ(3),
  ALTER COLUMN created_at   TYPE TIMESTAMPTZ(3),
  ALTER COLUMN settled_at   TYPE TIMESTAMPTZ(3);

ALTER TABLE chat_messages
  ALTER COLUMN created_at   TYPE TIMESTAMPTZ(3),
  ALTER COLUMN completed_at TYPE TIMESTAMPTZ(3);

ALTER TABLE idempotency_keys
  ALTER COLUMN claimed_at TYPE TIMESTAMPTZ(3),
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3),
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3);
