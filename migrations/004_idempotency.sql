CREATE TABLE idempotency_keys (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  idempotency_key     TEXT NOT NULL,

  -- Hash of the request that first claimed this key. A retry carrying the same
  -- key but a different body is a client bug, not a retry, and is rejected.
  request_fingerprint TEXT NOT NULL,

  status              TEXT NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  response_status     INTEGER,
  response_body       JSONB,

  claimed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The whole mechanism rests on this constraint: the winner of a concurrent
  -- claim is decided by the database, atomically, not by application code.
  -- Scoped per user so one tenant can neither collide with nor probe another's keys.
  CONSTRAINT idempotency_keys_scope_key UNIQUE (user_id, idempotency_key),
  CONSTRAINT idempotency_settled_has_response CHECK (
    (status = 'PROCESSING') = (response_status IS NULL)
  )
);
