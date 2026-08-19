CREATE TABLE chat_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  question          TEXT NOT NULL,
  answer            TEXT,
  status            TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),

  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,

  -- Which allowance paid for this message. Kept on the message itself so the
  -- charge can be reversed if the provider call fails, and so usage history
  -- survives the bundle being cancelled, renewed or expired.
  charge_source     TEXT NOT NULL CHECK (charge_source IN ('FREE_TIER', 'BUNDLE')),
  charge_bundle_id  UUID REFERENCES subscription_bundles (id) ON DELETE SET NULL,
  charge_period     TEXT,
  charge_refunded   BOOLEAN NOT NULL DEFAULT FALSE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,

  CONSTRAINT chat_charge_target_matches_source CHECK (
    (charge_source = 'BUNDLE'    AND charge_bundle_id IS NOT NULL AND charge_period IS NULL) OR
    (charge_source = 'FREE_TIER' AND charge_bundle_id IS NULL     AND charge_period IS NOT NULL)
  ),
  CONSTRAINT chat_answer_present_when_completed CHECK (
    (status <> 'COMPLETED') OR (answer IS NOT NULL AND total_tokens IS NOT NULL)
  )
);

CREATE INDEX chat_messages_user_created_idx ON chat_messages (user_id, created_at DESC);
