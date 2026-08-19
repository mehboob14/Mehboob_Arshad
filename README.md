# AI Chat & Subscription Bundles — Backend Assessment

TypeScript · Express 5 · PostgreSQL · Clean Architecture (DDD-style)

Both modules are implemented: metered AI chat, and the subscription bundles that fund it.

---

## Setup

Requires Node 20+ and PostgreSQL 16+.

```bash
createdb ggi_assessment       # or: psql -U postgres -c "CREATE DATABASE ggi_assessment"
cp .env.example .env          # then set DATABASE_URL
npm install
npm run setup                 # applies migrations and seeds demo users
npm run dev                   # http://localhost:3000
```

Postgres via Docker instead of a local install — this creates the database for you:

```bash
docker compose up -d
```

Seeded users (fixed ids, so requests can be copied straight out of this file):

| User ID                                | State                                        |
| -------------------------------------- | -------------------------------------------- |
| `11111111-1111-1111-1111-111111111111` | Free tier only                               |
| `22222222-2222-2222-2222-222222222222` | Basic bundle, 1 message remaining            |
| `33333333-3333-3333-3333-333333333333` | Basic + Pro, to demonstrate bundle selection |
| `44444444-4444-4444-4444-444444444444` | Basic + Enterprise, to demonstrate unlimited |

`api.http` has a runnable request for every behaviour described below.

```bash
npm test          # 61 tests: 32 unit, 29 integration (integration needs the database)
npm run lint
npm run typecheck
```

---

## API

Authentication is out of scope, so the caller asserts identity with an `X-User-Id` header
(see [Assumptions](#assumptions)).

**Module 1 — chat**

| Method | Path                    | Purpose                                                |
| ------ | ----------------------- | ------------------------------------------------------ |
| `POST` | `/api/v1/chat/messages` | Ask a question. Accepts an optional `Idempotency-Key`. |
| `GET`  | `/api/v1/chat/messages` | Message history (`?limit=&before=`).                   |
| `GET`  | `/api/v1/usage`         | Current allowances and remaining balance.              |

**Module 2 — subscriptions**

| Method  | Path                               | Purpose                                               |
| ------- | ---------------------------------- | ----------------------------------------------------- |
| `POST`  | `/api/v1/subscriptions`            | Buy a bundle. Accepts an optional `Idempotency-Key`.  |
| `GET`   | `/api/v1/subscriptions`            | The caller's bundles.                                 |
| `GET`   | `/api/v1/subscriptions/:id`        | One bundle, with its billing periods (usage history). |
| `PATCH` | `/api/v1/subscriptions/:id`        | Toggle auto-renew.                                    |
| `POST`  | `/api/v1/subscriptions/:id/cancel` | Cancel at the end of the current period.              |
| `POST`  | `/api/v1/billing/run`              | Run the billing cycle. Stands in for the scheduler.   |

Every failure returns the same envelope, with a machine-readable code and enough context to act
on without a second request:

```json
{
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "The free monthly allowance is spent and no subscription bundle has remaining quota.",
    "details": {
      "freeRemaining": 0,
      "freeResetsAt": "2026-09-01T00:00:00.000Z",
      "activeBundles": [],
      "resolution": "Purchase a subscription bundle, or wait for the free allowance to reset."
    }
  }
}
```

| Code                          | Status | Meaning                                                          |
| ----------------------------- | ------ | ---------------------------------------------------------------- |
| `QUOTA_EXCEEDED`              | 402    | No allowance can pay for the message. Not throttling — unfunded. |
| `PAYMENT_DECLINED`            | 402    | The gateway said no. The bundle is recorded as `PAYMENT_FAILED`. |
| `REQUEST_IN_PROGRESS`         | 409    | A request with this idempotency key is still running.            |
| `INVALID_SUBSCRIPTION_STATE`  | 409    | The transition is not legal from the current state.              |
| `IDEMPOTENCY_KEY_REUSED`      | 422    | Same key, different body.                                        |
| `VALIDATION_FAILED`           | 422    | Payload rejected at the boundary.                                |
| `AI_PROVIDER_UNAVAILABLE`     | 503    | Provider failed; the charge has been reversed.                   |
| `PAYMENT_GATEWAY_UNAVAILABLE` | 502    | Charge outcome unknown. Never retried automatically.             |

---

## Structure

```
src/
  modules/
    chat/            domain · services · repositories · infrastructure · controllers
    subscriptions/   domain · services · repositories · infrastructure · controllers
  shared/
    domain/          clock, calendar month, error base, allowance contract
    persistence/     unit of work, Postgres adapter, migration runner
    idempotency/     claim store and the controller decorator
    http/            result type, error mapping, auth stub
  container.ts       composition root — the only file that knows an interface's implementation
migrations/          plain SQL, applied in order and recorded
```

Dependencies point inwards: `domain` knows nothing of Express, `pg`, or the other module. That
rule is enforced by ESLint (`no-restricted-imports` on the domain folders) rather than by
convention, so a violation fails the lint step instead of surviving review.

The two modules share no code. They agree on one contract in the shared kernel —
`AllowanceCharge`, which says _what paid_ for a message — and chat states its need as a port
(`AllowanceGate`) that `EntitlementService` happens to satisfy. Chat depends on being able to
obtain an allowance, not on bundles existing.

Migrations are append-only. `005_billing.sql` alters constraints that `002` created rather than
editing `002`, because an applied migration is history: rewriting it silently diverges every
database that already ran it.

---

## The parts that carry the weight

### 1. Concurrent requests cannot spend the same last credit

Two requests arriving together for a user with one message left is the failure that costs real
money, and a `SELECT` followed by an `UPDATE` in application code does not prevent it. There are
three independent defences, each of which alone would be sufficient:

1. **Row locks.** `loadForUpdate` takes `SELECT … FOR UPDATE` over the free-period row and every
   candidate bundle, always in the same order — free row first, then bundles by primary key — so
   concurrent requests for one user queue rather than deadlock on a crossed acquisition order.
2. **Conditional writes.** The deduction re-asserts the balance in its own `WHERE` clause
   (`AND used < granted`), so a write that somehow escaped the lock still cannot overdraw. Zero
   rows updated is treated as a conflict, not as success.
3. **Database constraints.** `CHECK (used <= granted)` and
   `CHECK (max_messages IS NULL OR used_messages <= max_messages)` make an overdrawn balance
   unrepresentable regardless of what the application believes.

Proven by [`tests/integration/quota.test.ts`](tests/integration/quota.test.ts), which fires eight
simultaneous requests at a single remaining credit and asserts exactly one succeeds.

### 2. A retry does not charge twice

The mocked provider takes a few hundred milliseconds, which is exactly long enough for a client
to time out, a user to double-click, or a proxy to retry. The classic implementation —
_check the key, do the work, save the key_ — has a window between the check and the save in
which both requests pass.

So the key is **claimed, not checked**:

```
INSERT INTO idempotency_keys (…, status) VALUES (…, 'PROCESSING')
ON CONFLICT ON CONSTRAINT idempotency_keys_scope_key DO NOTHING
RETURNING id
```

The `UNIQUE` constraint decides the winner atomically, inside the database, before any work
begins. `ON CONFLICT DO NOTHING` is used rather than catching SQLSTATE 23505 because a raised
error would abort any enclosing transaction; the guarantee comes from the constraint either way.
The claim is committed immediately, so a competing request observes it rather than blocking on it.

A losing request then resolves against the stored record:

| Stored state        | Response                                                                            |
| ------------------- | ----------------------------------------------------------------------------------- |
| `COMPLETED`         | The recorded response, byte for byte, with `Idempotency-Replayed: true`.            |
| `FAILED`            | The recorded refusal. The same key means the same operation, including its outcome. |
| `PROCESSING`        | `409` — the original is still in flight. Never a second attempt.                    |
| Fingerprint differs | `422` — the same key with a different body is a client bug, not a retry.            |

Two further details:

- **Abandoned claims.** If the owning process dies mid-flight the row would stay `PROCESSING`
  forever, so a claim older than `IDEMPOTENCY_CLAIM_TIMEOUT_MS` can be taken over — by a
  conditional `UPDATE`, so only one retry can win it.
- **Retryable vs. deterministic failure.** A quota refusal is this operation's outcome and is
  recorded, so replays see the same refusal. A provider outage is not an outcome at all: the
  claim is released so the same key may genuinely be retried. `DomainError.retryable` draws the
  line, rather than the idempotency layer guessing from a status code.

Keys are scoped `UNIQUE (user_id, idempotency_key)` rather than globally unique, so one caller can
neither collide with nor probe another's keys. The same decorator protects both money paths:
sending a message and buying a bundle.

### 3. Quota is reserved before the provider is called, and refunded if it fails

`ChatService.ask` is _reserve → call → settle_:

1. In one transaction: consume the allowance and insert the message as `PENDING`.
2. **Outside** any transaction, holding no locks: call the provider.
3. In a second transaction: record the answer and tokens.

Reserving first means a request can never obtain an answer it did not pay for. Releasing the
locks first means a user is not serialised behind the slowest dependency in the system — a
provider that hangs would otherwise hold a lock on that user's balance until the socket timed
out. The cost of that choice is that failure needs a compensating transaction rather than a
rollback, so a failed call marks the message `FAILED` and reverses the charge in one step. The
user is not billed for an answer they never received.

### 4. A billing run cannot charge the same period twice

The same discipline, applied to actual money. Before any charge, the run **claims the period**:

```
INSERT INTO subscription_billing_periods (bundle_id, period_start, …, status)
VALUES (…, 'PENDING')
ON CONFLICT ON CONSTRAINT billing_period_once_per_start DO NOTHING
```

`UNIQUE (bundle_id, period_start)` admits exactly one claimant, so two runners racing on the same
renewal cannot both reach the gateway. The claim is committed before the gateway call, and no
row lock is held across it. The gateway reference is derived from the same pair
(`sub_<bundleId>_<periodStart>`), so a retry presents an identical idempotency key to the
provider.

The three outcomes are each handled deliberately:

- **Paid** — the closing period's usage is snapshotted, the bundle rolls into the next period and
  its message allowance resets.
- **Declined** — the bundle becomes `PAYMENT_FAILED` and immediately stops serving messages, which
  is the brief's "mark subscription inactive".
- **Unknown** (the gateway threw) — the claim stays `PENDING` and the subscription is reported
  under `needsReconciliation`. It is **never** retried automatically, because retrying a charge
  whose outcome is unknown is exactly how customers get billed twice. The same rule governs the
  HTTP path: `PAYMENT_GATEWAY_UNAVAILABLE` is deliberately not `retryable`.

A run that crashes half way is safe to re-run: a period already settled replays its recorded
outcome and finishes advancing the subscription instead of charging again. Each subscription is
its own transaction, so one failure never stops the batch.

### 5. Cancellation ends the cycle without ending the service

Cancelling is not a status change, because the user has already paid for the current period:

```
PENDING_PAYMENT ──activate──▶ ACTIVE ──renew──▶ ACTIVE ──▶ …
       │                       │  │
       └──decline──▶ PAYMENT_FAILED│  (renewal declined)
                                   │
                     cancel ───────┤ (still ACTIVE, still serving,
                                   │  auto-renew off, renewalDate null)
                                   │
                     period ends ──┴──▶ CANCELLED  (the user ended it)
                                   └──▶ EXPIRED    (it simply ran out)
```

So a cancelled bundle keeps answering questions until `endDate`, does not renew, and leaves every
`chat_message` and every `subscription_billing_period` in place. The closing usage of each period
is snapshotted into its billing period row before the bundle's counter resets, so history
survives renewal, cancellation and expiry alike.

Every transition above is a method on the aggregate, so the legal lifecycle is readable in one
file instead of being inferred from scattered `UPDATE` statements — and an illegal transition
throws rather than silently corrupting the record.

### 6. The monthly reset has no moving parts

The free grant is keyed `(user_id, period)` where period is the UTC calendar month. A new month
is a different row, created on first use. There is no scheduled job to reset counters, which
means no window in which the reset can be missed, run twice, run late, or race a request that
arrives at midnight — and a `FixedClock` makes the rollover a three-line test rather than
something you wait a month to observe.

### 7. The rules that matter are pure functions

`selectAllowance(snapshot, at)` takes entities and returns a decision — no database, no clock
lookup, no HTTP. `addBillingCycle(from, cycle)` is the same. Both are exhaustively unit-tested,
including the cases that only bite in production: a subscription started on the 31st renews on the
28th rather than sliding into March, and a leap day renews on the 28th the following year.

Randomness and time are injected, never read from a global. `SimulatedPaymentGateway` takes its
`random` function as a constructor argument, because billing behaviour that only appears one time
in five is behaviour that never gets tested.

---

## Assumptions

The brief left several things open. Each was resolved in the direction that is best for the
user's money, and isolated so the opposite reading is a small change.

**"Deduct usage from the bundle with the latest remaining quota."** Read as _the greatest
remaining balance_. Ties break on the earliest end date, so credit that is about to expire is
spent before credit that is not. If "latest" was meant as _most recently purchased_, only the
comparator in `entitlement-policy.ts` changes.

**Free messages are spent before any bundle.** They cost the user nothing, so no paid balance
should be consumed while free messages remain.

**Enterprise (unlimited) is used last, not first.** A literal reading of "greatest remaining"
would select unlimited every time. That is worse for the user: an unlimited message costs nothing
extra, whereas prepaid metered credit expires unused. Unlimited is therefore the fallback.

**Unlimited is `NULL`, not a large number.** There is no sentinel that arithmetic can exhaust.

**A bundle's quota belongs to its billing cycle**, and renewal resets it. A yearly Pro bundle
grants 100 responses for that year — the literal reading of the brief, and consistent with
renewal opening a new period. If the intent was 100 _per month_ on a yearly plan, that is a
change to how a period grants its allowance and nothing else moves. **This is the one open
question worth confirming**, because it is the only one where the two readings differ materially.

**Cancellation takes effect at the end of the paid period**, not immediately — the standard
reading of "ends the current billing cycle", and the only one consistent with "preserves usage
history". Service continues to `endDate`; only renewal stops.

**A declined first charge still creates a record.** The bundle is stored as `PAYMENT_FAILED`
rather than discarded, so a failed purchase is auditable instead of invisible. It serves nothing.

**Authentication is out of scope.** The brief never mentions login, tokens or sessions, so the
caller asserts identity via `X-User-Id`. It is isolated in one middleware precisely so that real
token verification replaces it without touching any business logic. `POST /api/v1/billing/run`
carries no user identity at all: it stands in for a scheduler, and in production would be a cron
target behind operational auth rather than a route.

**Time is injected, never read from a global.** Everything that depends on "now" takes a `Clock`,
which is what makes month rollover and renewal behaviour testable.

**Prices in the tier catalog are invented.** The brief specifies quotas, not amounts. Money is
stored in integer cents; no float ever touches a balance.

**All timestamps are UTC**, including the month boundary for the free grant.

### Known limitations, stated rather than hidden

- If the process dies between the provider returning and the settle transaction committing, a
  chat message stays `PENDING` with the charge applied. A reaper over `PENDING` messages older
  than a timeout would close it; it is deliberately not built here.
- A charge with an unknown outcome is reported, not resolved. Resolving it needs a gateway lookup
  by reference, which a simulated gateway cannot offer.
- Idempotency records are never pruned. A retention job belongs alongside a real deployment.
- History pagination is a simple `before` cursor on `created_at`; it does not disambiguate
  messages sharing a timestamp to the microsecond.

### Deliberately not built

Real OpenAI calls, real payments, authentication, rate limiting, caching, an outbox, a job
scheduler, proration or refunds on cancellation, plan upgrades, observability wiring, or
containerising the app itself. Each would be right in production and wrong in a scoped exercise;
the boundaries above are where they would attach.

---

## Tests

Not coverage for its own sake — one test per rule the brief states, plus the races that break
metering and billing systems in production.

| Test                                    | What breaks if it fails                              |
| --------------------------------------- | ---------------------------------------------------- |
| 8 concurrent requests, 1 credit         | Users consume more than they paid for                |
| 8 concurrent requests, 1 free message   | Same, on the free path                               |
| Duplicate `Idempotency-Key`             | Users are charged twice for one retry                |
| Simultaneous duplicate keys             | The double-click case, in flight                     |
| Same key, different body                | Silent key reuse corrupts the record                 |
| AI provider failure                     | Users pay for answers they never got                 |
| Month rollover with a fixed clock       | The free grant never resets, or resets wrongly       |
| Bundle selection order                  | The wrong balance is drained; credit expires unused  |
| Repeated billing run                    | Subscribers are charged twice for one period         |
| Concurrent billing runs                 | Same, under a race                                   |
| Declined renewal                        | An unpaid subscription keeps serving                 |
| Gateway timeout during renewal          | An unknown charge is retried and duplicated          |
| Cancel, then run billing past `endDate` | Cancellation deletes history, or service stops early |
| Duplicate purchase key                  | A user is billed twice for one bundle                |
| Month-end and leap-day renewal dates    | Every subsequent renewal date drifts                 |
