# AI Chat & Subscription Bundles

A metered AI chat API funded by subscription bundles.
TypeScript · Express 5 · PostgreSQL · Clean Architecture (DDD-style)

**Status:** both modules complete.

---

## Contents

- [Setup](#setup)
- [Verifying this in five minutes](#verifying-this-in-five-minutes)
- [What this system has to get right](#what-this-system-has-to-get-right)
- [Requirements coverage](#requirements-coverage)
- [API](#api)
- [Architecture](#architecture)
- [Engineering decisions](#engineering-decisions)
- [How this was verified](#how-this-was-verified)
- [Edge cases](#edge-cases)
- [Assumptions, and why](#assumptions-and-why)
- [Known limitations](#known-limitations)
- [Deliberately not built](#deliberately-not-built)
- [Tests](#tests)

---

## Setup

Requires Node 20+ and PostgreSQL 16+.

```bash
createdb ggi_assessment       # or: psql -U postgres -c "CREATE DATABASE ggi_assessment"
cp .env.example .env          # then set DATABASE_URL
npm install
npm run setup                 # applies migrations, seeds demo users
npm run dev                   # http://localhost:3000
```

Postgres via Docker instead of a local install — this creates the database for you:

```bash
docker compose up -d
```

```bash
npm test          # 70 tests (integration needs the database)
npm run lint
npm run typecheck
```

Seeded users, with fixed ids so every request below can be copied and run as-is:

| User ID                                | State                                        |
| -------------------------------------- | -------------------------------------------- |
| `11111111-1111-1111-1111-111111111111` | Free tier only                               |
| `22222222-2222-2222-2222-222222222222` | Basic bundle, 1 message remaining            |
| `33333333-3333-3333-3333-333333333333` | Basic + Pro, to demonstrate bundle selection |
| `44444444-4444-4444-4444-444444444444` | Basic + Enterprise, to demonstrate unlimited |

---

## Verifying this in five minutes

`api.http` has a runnable request for every behaviour described here. Users who hold a bundle are
seeded with the free grant already spent, so those requests exercise the bundle they were written
to demonstrate rather than quietly drawing on the free tier for the first three clicks. The three worth running
first, because they are the three that are hard to get right:

**1. The free grant, then a structured refusal.** Send the same request four times as the
free-tier user. The fourth returns `402` with everything a client needs to recover:

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

**2. A retry does not charge twice.** Send any message twice with the same `Idempotency-Key`.
The second returns the identical body plus `Idempotency-Replayed: true`, and `GET /api/v1/usage`
shows one message consumed, not two. Change the body while keeping the key and it is rejected
`422` — that is a client bug, not a retry.

**3. Cancellation ends the cycle without ending the service.** Buy a bundle, cancel it, and read
it back: `status` stays `ACTIVE`, `cancelAtPeriodEnd` is `true`, `autoRenew` is `false`,
`renewalDate` is `null`. It keeps answering questions until `endDate`, then closes as `CANCELLED`
with its usage history intact.

Or just run `npm test` — every claim in this document is an assertion in the suite.

---

## What this system has to get right

The brief describes a chat endpoint and a subscription CRUD surface. Building only that would
miss the point: the mocked provider is five lines, and CRUD is scaffolding. What is actually
being built here is **a metering and billing system**, and metering systems fail in three
specific, expensive ways. Every design decision in this repository is aimed at one of them.

**1. Money leaks under concurrency.** Two requests arrive together for a user with one message
left. A `SELECT` to check the balance followed by an `UPDATE` to spend it — the obvious
implementation — lets both through, because nothing prevents a second transaction reading the
same balance in the gap between them. At small scale it is invisible. At real traffic it is a
line item. See [decision 1](#1-concurrent-requests-cannot-spend-the-same-last-credit).

**2. Money leaks on retries.** The brief asks for a simulated provider _delay_. That delay is not
decoration: a few hundred milliseconds is exactly long enough for a client to time out, a user to
double-click, or a proxy to retry — and a naive endpoint bills every one of those as a fresh
request. The same hazard applies to buying a bundle and to renewing one.
See [decision 2](#2-a-retry-does-not-charge-twice).

**3. State drifts because time is treated as a background process.** "Auto reset on the 1st of
each month" and "auto-renew subscriptions" both sound like cron jobs. Scheduled mutation of
financial state is where systems accumulate their worst bugs: a job that runs twice, runs late,
races a request at midnight, or dies half way and leaves a customer charged with nothing to show
for it. See [decisions 4, 5 and 6](#4-a-billing-run-cannot-charge-the-same-period-twice).

Two further requirements read as deliberate ambiguity rather than oversight, and both are
resolved explicitly in [Assumptions](#assumptions-and-why) rather than silently: _"deduct from
the bundle with the latest remaining quota"_, which has two defensible readings, and _"unlimited"_
as a tier, which quietly breaks any ordering built on "most remaining".

The rest of this document is organised around those problems, not around the file tree.

---

## Requirements coverage

Every bullet in the brief, where it is implemented, and the test that proves it.

### Module 1 — AI Chat

| Requirement                                            | Implementation                                                                                                       | Proof                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Accepts a user question                                | `POST /api/v1/chat/messages`, validated at the boundary with zod                                                     | `VALIDATION_FAILED` on empty or oversized input                      |
| Returns a mocked OpenAI response                       | [`mock-openai.provider.ts`](src/modules/chat/infrastructure/mock-openai.provider.ts) behind an `AiChatProvider` port | swapped for a stub in tests                                          |
| Stores question, answer and tokens                     | `chat_messages` ([`003_chat.sql`](migrations/003_chat.sql)), with prompt/completion/total token columns              | `GET /api/v1/chat/messages`                                          |
| 3 free messages per user per month                     | `free_allowance_periods`, keyed `(user_id, period)`                                                                  | _grants the configured number of free messages, then refuses_        |
| Bundle required once free is spent                     | [`entitlement-policy.ts`](src/modules/subscriptions/domain/entitlement-policy.ts)                                    | _falls through to a bundle when the free grant is spent_             |
| Multiple active bundles, different tiers               | `subscription_bundles`, with no uniqueness on `(user, tier)`                                                         | _prefers the bundle with the greatest remaining balance_             |
| Basic 10 / Pro 100 / Enterprise unlimited              | [`tier.ts`](src/modules/subscriptions/domain/tier.ts); unlimited is `NULL`, not a sentinel                           | _keeps an unlimited bundle in reserve until metered credit runs out_ |
| Deduct from the bundle with the latest remaining quota | `selectAllowance` ordering — see [assumption](#deduct-usage-from-the-bundle-with-the-latest-remaining-quota)         | 8 unit tests on the ordering alone                                   |
| Auto reset free quota on the 1st                       | The month is part of the key; a new month is a new row. No job.                                                      | _resets the free grant when the calendar month turns over_           |
| Structured errors when quota is exceeded               | `QuotaExceededError` → `402`, with a machine-readable code and recovery context                                      | asserted field by field                                              |
| Simulate OpenAI response delay                         | `AI_LATENCY_MIN_MS` / `AI_LATENCY_MAX_MS`                                                                            | drives the in-flight duplicate test                                  |

### Module 2 — Subscription Bundles

| Requirement                                                   | Implementation                                                                                                                                           | Proof                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Create bundles (Basic/Pro/Enterprise)                         | `POST /api/v1/subscriptions`, idempotent                                                                                                                 | _activates the bundle and records a paid period when the charge succeeds_ |
| Billing cycle: monthly or yearly                              | [`billing-cycle.ts`](src/modules/subscriptions/domain/billing-cycle.ts)                                                                                  | 6 unit tests, including month-end and leap-day clamping                   |
| Toggle auto-renew                                             | `PATCH /api/v1/subscriptions/:id`                                                                                                                        | _refuses to turn auto-renew back on after cancellation_                   |
| `maxMessages`, `price`, `startDate`, `endDate`, `renewalDate` | all on the aggregate and in the API response; money in integer cents                                                                                     | visible in every subscription payload                                     |
| Auto-renew subscriptions if enabled                           | `BillingService.run`                                                                                                                                     | _renews, resets the allowance, and keeps the closed period as history_    |
| Payment fails randomly → mark inactive                        | [`simulated-payment.gateway.ts`](src/modules/subscriptions/infrastructure/simulated-payment.gateway.ts); failure → `PAYMENT_FAILED`, which stops serving | _stops service when the renewal payment is declined_                      |
| Cancellation ends the current billing cycle                   | `cancel()` sets `cancelledAt`; the billing run closes it at `endDate`                                                                                    | _closes a cancelled subscription as CANCELLED_                            |
| Cancellation prevents renewal                                 | `autoRenew → false`, `renewalDate → null`, enforced by a DB constraint                                                                                   | _expires a subscription that was never set to renew, without charging_    |
| Cancellation preserves usage history                          | closing usage is snapshotted into `subscription_billing_periods` before the counter resets                                                               | _…and preserves its usage_                                                |

### Architecture

| Requirement                                                  | How                                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Clean Architecture (DDD-style)                               | Ports declared in `domain`, implemented in `repositories`/`infrastructure`, wired in one composition root |
| Layers: domain/entities, services, repositories, controllers | Exactly these directory names, per module                                                                 |
| Modules organised independently                              | `chat/` and `subscriptions/` share no code — only a shared-kernel contract                                |
| TypeScript-first                                             | `strict`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`             |
| Prettier and ESLint configured                               | `npm run lint` / `npm run format`; ESLint additionally enforces the dependency rule                       |

---

## API

Authentication is out of scope, so the caller asserts identity with an `X-User-Id` header
(see [Assumptions](#authentication-is-out-of-scope)).

**Chat**

| Method | Path                    | Purpose                                                |
| ------ | ----------------------- | ------------------------------------------------------ |
| `POST` | `/api/v1/chat/messages` | Ask a question. Accepts an optional `Idempotency-Key`. |
| `GET`  | `/api/v1/chat/messages` | Message history (`?limit=&before=`).                   |
| `GET`  | `/api/v1/usage`         | Current allowances and remaining balance.              |

**Subscriptions**

| Method  | Path                               | Purpose                                               |
| ------- | ---------------------------------- | ----------------------------------------------------- |
| `POST`  | `/api/v1/subscriptions`            | Buy a bundle. Accepts an optional `Idempotency-Key`.  |
| `GET`   | `/api/v1/subscriptions`            | The caller's bundles.                                 |
| `GET`   | `/api/v1/subscriptions/:id`        | One bundle, with its billing periods (usage history). |
| `PATCH` | `/api/v1/subscriptions/:id`        | Toggle auto-renew.                                    |
| `POST`  | `/api/v1/subscriptions/:id/cancel` | Cancel at the end of the current period.              |
| `POST`  | `/api/v1/billing/run`              | Run the billing cycle. Stands in for the scheduler.   |

Every failure returns one envelope — `{ "error": { code, message, details } }` — with a
machine-readable code and enough context to recover without a second round trip.

| Code                          | Status        | Meaning                                                          |
| ----------------------------- | ------------- | ---------------------------------------------------------------- |
| `QUOTA_EXCEEDED`              | 402           | No allowance can pay for the message. Not throttling — unfunded. |
| `PAYMENT_DECLINED`            | 402           | The gateway said no. The bundle is recorded as `PAYMENT_FAILED`. |
| `REQUEST_IN_PROGRESS`         | 409           | A request with this idempotency key is still running.            |
| `INVALID_SUBSCRIPTION_STATE`  | 409           | The transition is not legal from the current state.              |
| `IDEMPOTENCY_KEY_REUSED`      | 422           | Same key, different body.                                        |
| `VALIDATION_FAILED`           | 400, 413, 422 | Body unreadable, over the size limit, or failing validation.     |
| `PAYMENT_GATEWAY_UNAVAILABLE` | 502           | Charge outcome unknown. Never retried automatically.             |
| `AI_PROVIDER_UNAVAILABLE`     | 503           | Provider failed; the charge has been reversed.                   |

`402` rather than `429` for an exhausted quota is deliberate: the request is not being throttled,
it is unfunded. Retrying later without buying anything will not help, and the status code should
say so.

---

## Architecture

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

**Dependencies point inwards.** `domain` knows nothing of Express, `pg`, or the other module —
and that rule is enforced by ESLint (`no-restricted-imports` scoped to the domain folders) rather
than by convention, so a violation fails the build instead of surviving review.

**The two modules share no code.** They agree on one contract in the shared kernel —
`AllowanceCharge`, which says _what paid_ for a message — and chat declares its need as a port
(`AllowanceGate`) that `EntitlementService` happens to satisfy. Chat depends on being able to
obtain an allowance, not on bundles existing. Adding a promotional-credits source later means one
new implementation and no change to chat.

**Controllers return values, they do not write responses.** A controller is
`(req) => Promise<HttpResult>`, so everything that decorates one — idempotency today, rate
limiting or caching tomorrow — is plain function composition rather than response interception,
and every controller is unit-testable without a server.

**Migrations are append-only.** `005_billing.sql` alters constraints that `002` created rather
than editing `002`, because an applied migration is history: rewriting it silently diverges every
database that already ran it.

**Timestamps are millisecond-precision by column type.** PostgreSQL stores `timestamptz` to
microseconds; a JavaScript `Date` carries milliseconds. A value the database generated therefore
lost its last three digits on the way into the application, and any query matching a row by
timestamp equality silently found nothing. `006_timestamp_precision.sql` pins every timestamp
column to `timestamptz(3)`, so the two sides agree by construction instead of by luck.

**Everything ambient is injected.** Time (`Clock`), randomness (`SimulatedPaymentGateway`'s
`random`), the AI provider and the payment gateway all arrive through the constructor. That is
not architectural decoration — it is the only reason a month rollover, a leap-day renewal and a
declined card are testable at all. There is no mocking framework in this repository, and none is
needed.

---

## Engineering decisions

### 1. Concurrent requests cannot spend the same last credit

The failure: two requests arrive together for a user with one message left, both read the
balance, both find it sufficient, both spend it. Three independent defences, each of which alone
would be sufficient:

1. **Row locks.** `loadForUpdate` takes `SELECT … FOR UPDATE` over the free-period row and every
   candidate bundle, always in the same order — free row first, then bundles by primary key — so
   concurrent requests for one user queue behind each other rather than deadlock on a crossed
   acquisition order.
2. **Conditional writes.** The deduction re-asserts the balance in its own `WHERE` clause
   (`AND used < granted`). A write that somehow escaped the lock still cannot overdraw, and zero
   rows updated is treated as a conflict, not as success.
3. **Database constraints.** `CHECK (used <= granted)` and
   `CHECK (max_messages IS NULL OR used_messages <= max_messages)` make an overdrawn balance
   unrepresentable regardless of what the application believes.

Layer 1 is the mechanism; layers 2 and 3 exist so that a future refactor which quietly breaks
layer 1 fails loudly instead of leaking money silently.

Proven by firing eight simultaneous requests at a single remaining credit and asserting exactly
one `201` — on both the bundle path and the free path.

### 2. A retry does not charge twice

The ordering is the whole design:

```
check key -> charge -> save key + response     <- both requests pass in the gap
insert key -> charge -> save response          <- the database picks a winner first
```

The first is what almost everyone writes, and it is wrong: between reading the key and writing it
there is a window in which a second request reads the same absence and proceeds. The window is
small, which is exactly why it survives review and shows up later as duplicate charges.

So the key is **claimed, not checked**:

```sql
INSERT INTO idempotency_keys (user_id, idempotency_key, request_fingerprint, status)
VALUES ($1, $2, $3, 'PROCESSING')
ON CONFLICT ON CONSTRAINT idempotency_keys_scope_key DO NOTHING
RETURNING id
```

and the claim is only meaningful because of one line in the schema:

```sql
CONSTRAINT idempotency_keys_scope_key UNIQUE (user_id, idempotency_key)
```

`request_fingerprint` is `NOT NULL` for the same reason: a nullable column lets a code path skip
the check and silently lose duplicate protection for that request.

The `UNIQUE` constraint picks the winner atomically, inside the database, before any work begins.
`ON CONFLICT DO NOTHING` is used rather than catching SQLSTATE `23505` because a raised error
would abort any enclosing transaction; the guarantee comes from the constraint either way. The
claim is committed immediately, so a competitor _observes_ it rather than blocking on it.

A losing request resolves against the stored record:

| Stored state        | Response                                                                            |
| ------------------- | ----------------------------------------------------------------------------------- |
| `COMPLETED`         | The recorded response, byte for byte, with `Idempotency-Replayed: true`.            |
| `FAILED`            | The recorded refusal. The same key means the same operation, including its outcome. |
| `PROCESSING`        | `409` — the original is still in flight. Never a second attempt.                    |
| Fingerprint differs | `422` — the same key with a different body is a client bug, not a retry.            |

The fingerprint is a SHA-256 of the canonicalised request, with object keys sorted at every depth,
so a payload the client happened to serialise in a different order is still recognised as the same
retry.

Two details that only matter in production:

- **Abandoned claims.** If the owning process dies mid-flight the row would stay `PROCESSING`
  forever, so a claim older than `IDEMPOTENCY_CLAIM_TIMEOUT_MS` can be taken over — by a
  conditional `UPDATE`, so only one retry can win it.
- **Retryable vs. deterministic failure.** A quota refusal is this operation's outcome and is
  recorded, so replays see the same refusal. A provider outage is not an outcome at all: the
  claim is released so the same key may genuinely be retried. `DomainError.retryable` draws that
  line explicitly, rather than the idempotency layer guessing from a status code.

- **Ownership is proved on every write.** A claim can change hands when its owner stalls past the
  timeout, and a stalled owner is not necessarily a dead one. Each claimant carries the instant it
  took ownership, and every later write is conditional on it, so a superseded request updates
  nothing rather than overwriting its successor's response or deleting a live claim.
- **Recording the outcome is not part of the work.** The write that records success happens
  _outside_ the try: the effect has already committed, so a failed bookkeeping write must not be
  mistaken for failed work. Treating it as one would release the claim and let a retry run
  everything a second time — and a retried purchase mints a new subscription id, so neither the
  billing-period constraint nor the gateway reference would deduplicate it. Leaving the claim in
  place makes that retry a `409`, which is recoverable; a duplicate charge is not.

Keys are scoped `UNIQUE (user_id, idempotency_key)` rather than globally, so one tenant can
neither collide with nor probe another's keys. The same decorator protects both money paths:
sending a message, and buying a bundle.

### 3. Quota is reserved before the provider is called, and refunded if it fails

`ChatService.ask` is _reserve → call → settle_:

1. One transaction: consume the allowance, insert the message as `PENDING`.
2. **Outside** any transaction, holding no locks: call the provider.
3. A second transaction: record the answer and tokens.

Reserving first means a request can never obtain an answer it did not pay for. Releasing the
locks first means a user is not serialised behind the slowest dependency in the system — a
provider that hangs would otherwise hold a lock on that user's balance until the socket timed out,
blocking every other request from that user.

The cost of that choice is that failure needs a compensating transaction rather than a rollback,
so a failed call marks the message `FAILED` and reverses the charge in one step. The user is not
billed for an answer they never received. This is a deliberate trade: a narrow reconciliation
window, in exchange for never holding a database lock across a network call.

### 4. A billing run cannot charge the same period twice

The same discipline, applied to actual money. Before any charge, the run **claims the period**:

```sql
INSERT INTO subscription_billing_periods (bundle_id, period_start, …, status)
VALUES (…, 'PENDING')
ON CONFLICT ON CONSTRAINT billing_period_once_per_start DO NOTHING
```

`UNIQUE (bundle_id, period_start)` admits exactly one claimant, so two runners racing on the same
renewal cannot both reach the gateway. The claim commits before the gateway call, and no row lock
is held across it. The gateway reference is derived from the same pair
(`sub_<bundleId>_<periodStart>`), so a retry presents an identical idempotency key downstream.

The three outcomes are each handled deliberately:

- **Paid** — the closing period's usage is snapshotted, the bundle rolls into the next period, and
  its message allowance resets.
- **Declined** — the bundle becomes `PAYMENT_FAILED` and immediately stops serving messages. That
  is the brief's "mark subscription inactive": inactive is expressed as _stops serving_, enforced
  in one place (`isServingAt`), not as a flag every read path has to remember to check.
- **Unknown** (the gateway threw) — the claim stays `PENDING` and the subscription is reported
  under `needsReconciliation`. It is **never** retried automatically, because retrying a charge
  whose outcome is unknown is exactly how customers get billed twice. The same rule governs the
  HTTP path: `PAYMENT_GATEWAY_UNAVAILABLE` is deliberately marked non-retryable.

A renewal advances the subscription only if it is still sitting on the boundary this run claimed.
Being merely overdue is not enough: a subscription several cycles behind stays overdue after
another runner advances it, and acting on that would move it through a period nobody claimed or
charged. When the subscription has moved on, the charge is still recorded and surfaced under
`needsReconciliation` — money that moved must never be invisible, which is the entire point of
claiming before charging.

A run that crashes half way is safe to re-run: a period already settled replays its recorded
outcome and finishes advancing the subscription instead of charging again. Each subscription is
its own transaction, so one failure never stops the batch.

The endpoint is not the design — in production this is a scheduled job. It is exposed as a route
so the behaviour can be demonstrated and tested without waiting a month, and it is safe to call
repeatedly by construction.

### 5. Cancellation ends the cycle without ending the service

Cancelling is deliberately **not** a status change, because the user has already paid for the
current period:

```
PENDING_PAYMENT ──activate──▶ ACTIVE ──renew──▶ ACTIVE ──▶ …
       │                        │  │
       └──decline──▶ PAYMENT_FAILED│  (renewal declined)
                                   │
                     cancel ───────┤ (still ACTIVE, still serving,
                                   │  auto-renew off, renewalDate null)
                                   │
                     period ends ──┴──▶ CANCELLED  (the user ended it)
                                   └──▶ EXPIRED    (it simply ran out)
```

A cancelled bundle keeps answering questions until `endDate`, does not renew, and leaves every
`chat_message` and every `subscription_billing_period` in place. `CANCELLED` and `EXPIRED` are
kept distinct because "the user left" and "it ran its course" are different facts, and a billing
system that conflates them cannot answer the only question anyone asks of it.

Every transition is a method on the aggregate, so the legal lifecycle is readable in one file
instead of being inferred from scattered `UPDATE` statements — and an illegal transition throws
rather than silently corrupting the record.

Bundles are created in `PENDING_PAYMENT`, not `ACTIVE`, so an unpaid subscription cannot serve a
single message in the window before its charge settles.

### 6. The monthly reset has no moving parts

The free grant is keyed `(user_id, period)`, where period is the UTC calendar month. A new month
is a different row, created on first use.

There is no scheduled job to reset counters — so there is no window in which the reset can be
missed, run twice, run late, or race a request that arrives at midnight on the 1st. The reset is
not an action the system performs; it is a consequence of the key changing. Historical months
remain queryable instead of being overwritten, and a `FixedClock` turns "prove the rollover works"
into a three-line test rather than something you wait a month to observe.

### 7. The rules that matter are pure functions

`selectAllowance(snapshot, at)` takes entities and returns a decision — no database, no clock
lookup, no HTTP. `addBillingCycle(from, cycle)` is the same. Both are exhaustively unit-tested,
including the cases that only bite in production: a subscription started on the 31st renews on the
28th rather than sliding into March, and a leap day renews on the 28th the following year. Naive
month arithmetic gets both wrong, and shifts every subsequent renewal date with it.

---

## How this was verified

The test suite is the floor, not the ceiling. Before submitting, this codebase went through a
structured adversarial review: independent passes over concurrency, idempotency, domain
correctness against the brief, security and multi-tenancy, and whether this document tells the
truth — with every finding handed to a separate pass whose only job was to **refute** it. Ten
defects were raised. Six survived. Four did not, and those four matter as much as the six.

### What survived, and why each mattered

| Defect                                                                                                     | Consequence                                                                                                                                                                                                                                 | Resolution                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A renewal charge whose subscription was closed under it returned early without settling the claimed period | The row stayed `PENDING` with no reference, unreachable by `findDue` and `findAwaitingPayment` alike, and absent from every report — the one outcome claim-then-charge exists to surface                                                    | The outcome is recorded regardless; the run reports it when it is the one that recorded it |
| A renewal advanced on "is this overdue" rather than "is this still on the boundary I claimed"              | A subscription several cycles behind stays overdue after another runner advances it, so an overtaken runner could move it through a period nobody claimed or charged — a free month, and a hole in the usage history                        | The guard compares the locked `endDate` against the period this run claimed                |
| The write recording success sat inside the `try`                                                           | Losing it looked like failed work and released the claim **after** the effect had committed. A retried purchase mints a new subscription id, so neither the period constraint nor the gateway reference could deduplicate the second charge | The write moved outside the `try`; its failure is absorbed, and the retry gets `409`       |
| A claim taken over on timeout had no fencing token                                                         | The previous owner — stalled, not dead — could return and overwrite its successor's recorded response, or delete a live claim so a third attempt ran the work again                                                                         | `claimed_at` is stamped from the injected clock and asserted on every later write          |
| An unreadable or oversized body fell through to `500`                                                      | The size limit was invisible to clients, a client bug was indistinguishable from an outage, and any caller could drive the 5xx rate and fill the log with stack traces                                                                      | Errors carrying a 4xx status are mapped to it                                              |
| Seeded bundle holders still had their free grant                                                           | The `api.http` request labelled as the bundle-selection demo charged the free tier instead, appearing to contradict the rule it was written to show                                                                                         | The seed spends the grant for users who hold a bundle                                      |

The first two are the interesting pair: both are the _same_ mistake in different clothes — trusting
a snapshot that another actor may have invalidated while a network call was in flight. That is the
cost of the deliberate choice not to hold a lock across the gateway, and it is worth paying, but it
has to be paid explicitly rather than assumed away.

### What was refuted, and why that matters more

One reviewer argued the renewal guard should also check `shouldRenewAt`, so that a cancellation
racing the gateway call is not charged. The refutation showed the money is **already gone** by the
time that line runs: the proposed guard could not prevent the charge, only prevent it being
recorded. It would have converted a visible problem into a silent one — strictly worse than the
bug it was aimed at.

Another argued a cancel racing a renewal leaves the subscription in a corrupt state. Running both
orderings through the real aggregate produced byte-identical snapshots, so there was nothing to
fix. A third challenged a claim in this document that a database `CHECK` constraint already
guarantees.

Adversarial verification is not ceremony. Two of those four "fixes" would have made the system
worse, and a review that only collects findings has no way to tell them apart.

### Every fix fails without its fix

A test that passes for the wrong reason is worse than no test, so each regression was checked by
reverting `src/` and re-running the suite:

```
× reports a charge for a period the subscription has since left
× never advances through a period it did not claim and charge
× stops a superseded claimant from clobbering or deleting the new claim
× rejects an unreadable body as a client error, not a server fault
× does not release the claim when recording the outcome fails
× proves ownership on every write, so a superseded claimant cannot clobber

Tests  6 failed | 64 passed (70)
```

That check earned its keep immediately. The first version of _never advances through a period it
did not claim_ **passed against the broken code** — three concurrent billing runs simply never hit
the interleave, so it asserted nothing. It was rewritten around a repository that hands back a
snapshot and then blocks, letting the other runner finish first, so the race is deterministic
rather than hoped for.

---

## Edge cases

Handled deliberately, each with a test.

| Edge case                                                  | Handling                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Two requests race for the last credit                      | Row locks in a fixed order, conditional write, `CHECK` constraint                             |
| Two requests race for the last _free_ message              | Same path — the free grant is locked exactly like a bundle                                    |
| Crossed lock ordering between concurrent requests          | Locks always acquired free-row-first, then bundles by primary key                             |
| Client retries a slow request                              | `Idempotency-Key` claimed before work begins; replay returns the recorded response            |
| Duplicate arrives while the original is in flight          | `409 REQUEST_IN_PROGRESS` — never a second attempt                                            |
| Same key, different body                                   | `422` — key reuse is a client bug, not a retry                                                |
| Two tenants pick the same key string                       | Keys scoped `UNIQUE (user_id, key)`; the fingerprint includes the user                        |
| Client reorders JSON fields on retry                       | Fingerprint canonicalises key order at every depth                                            |
| Process dies holding an idempotency claim                  | Stale claims taken over by conditional `UPDATE` after a timeout                               |
| AI provider fails after quota was deducted                 | Compensating transaction: message `FAILED`, charge reversed, key released for a genuine retry |
| Quota exhausted mid-retry                                  | The refusal is _recorded_, so a replay sees the same `402`, not a new evaluation              |
| Enterprise "unlimited" in a most-remaining ordering        | Unlimited is `NULL` and sorts last by policy, so perishable credit is spent first             |
| Bundle expires between purchase and use                    | `isServingAt` gates on the `[startDate, endDate)` window, not just status                     |
| Bundle cancelled but still inside the paid period          | Stays `ACTIVE` and keeps serving; only renewal stops                                          |
| Cancel called twice                                        | `409 INVALID_SUBSCRIPTION_STATE`                                                              |
| Auto-renew re-enabled after cancellation                   | Refused in the domain _and_ by a DB constraint                                                |
| First charge declined                                      | Bundle recorded as `PAYMENT_FAILED`, serves nothing, remains auditable                        |
| Gateway times out — outcome unknown                        | Claim held, reported for reconciliation, never auto-retried                                   |
| Two billing runs execute concurrently                      | `UNIQUE (bundle_id, period_start)` admits one; the other replays or defers                    |
| Billing run crashes half way                               | Re-run replays settled periods and finishes advancing the subscription                        |
| Renewal resets the counter                                 | Closing usage snapshotted into the billing period first, so history survives                  |
| Subscription started on the 31st                           | Anniversary clamped to the last valid day; no drift                                           |
| Leap day renewal                                           | 29 Feb renews 28 Feb the following year                                                       |
| Month boundary in a non-UTC local time                     | All period keys computed in UTC                                                               |
| Another user's subscription id                             | `404`, not `403` — existence is not disclosed                                                 |
| Free grant configured to zero                              | Supported; the policy falls straight through to bundles                                       |
| Timestamp written by the database, not the app clock       | Every timestamp column is `timestamptz(3)`, so the value survives a JS `Date` round trip      |
| Bookkeeping write fails after the effect committed         | The claim is kept rather than released: a retry gets `409`, never a second charge             |
| Claim taken over while its owner is stalled but alive      | `claimed_at` is a fencing token; a superseded owner's writes match no row                     |
| Runner overtaken between reading a subscription and acting | The renewal guard requires the subscription still be on the boundary it claimed               |
| Charge lands for a period the subscription has since left  | Recorded `PAID` and surfaced under `needsReconciliation` for a human                          |
| Body is not valid JSON, or over the size limit             | `400` / `413` with `VALIDATION_FAILED`, never a `500`                                         |

---

## Assumptions, and why

The brief left several things open. Each was resolved in the direction that is best for the
user's money, and isolated so that the opposite reading is a small, local change.

#### "Deduct usage from the bundle with the latest remaining quota"

Read as **the greatest remaining balance**, ties broken by the **earliest end date**.

_Why:_ "latest" admits two readings — greatest remaining, or most recently purchased. Draining
the largest pot first keeps the smaller ones spendable rather than stranding them, and the
tie-break spends credit that is about to expire before credit that is not. Both choices leave the
user with more usable balance than the alternatives.

_If the other reading was intended_, only the comparator in `entitlement-policy.ts` changes — a
single function, fully covered by unit tests.

#### Free messages are spent before any bundle

_Why:_ they cost the user nothing. No paid balance should be consumed while free messages remain.

#### Enterprise (unlimited) is used last, not first

_Why:_ a literal reading of "greatest remaining" selects unlimited every time, which is the worst
outcome for the user — an unlimited message costs nothing extra, whereas prepaid metered credit
expires unused. Unlimited is therefore the fallback, not the default.

#### Unlimited is `NULL`, not a large number

_Why:_ a sentinel like `999999` is a number, and numbers get decremented, compared, and eventually
exhausted. Absence of a limit cannot be.

#### A bundle's quota belongs to its billing cycle, and renewal resets it

A yearly Pro bundle grants 100 responses for that year.

_Why:_ this is the literal reading of the brief, and the one consistent with renewal opening a new
period. **This is the single assumption worth confirming**, because it is the only one where the
two readings differ materially: if the intent was 100 _per month_ on a yearly plan, that changes
how a period grants its allowance and nothing else moves.

#### Cancellation takes effect at the end of the paid period, not immediately

_Why:_ the standard reading of "ends the current billing cycle", and the only one consistent with
"preserves usage history". The user paid for the period; taking it away early is a refund
question, not a cancellation question.

#### A declined first charge still creates a record

_Why:_ a failed purchase should be auditable, not invisible. The bundle is stored as
`PAYMENT_FAILED` and serves nothing.

#### "Mark subscription inactive" is expressed as "stops serving"

_Why:_ encoding inactivity as a status that `isServingAt` gates on means every read path gets it
right by construction, instead of each one having to remember to check a flag.

#### Authentication is out of scope

The caller asserts identity via `X-User-Id`.

_Why:_ the brief never mentions login, tokens or sessions — building an auth system would be scope
the exercise did not ask for. It is isolated in one middleware precisely so that real token
verification replaces it without touching a line of business logic. `POST /api/v1/billing/run`
carries no user identity at all: it stands in for a scheduler, and would be a cron target behind
operational auth rather than a public route.

#### Time is injected, never read from a global

_Why:_ every rule about months, renewals and billing windows is otherwise untestable. This is the
difference between a suite that proves the reset works and one that hopes.

#### Prices in the tier catalogue are invented

_Why:_ the brief specifies quotas, not amounts. Money is stored in integer cents; no float ever
touches a balance.

#### All timestamps are UTC

_Why:_ including the month boundary for the free grant. A local-time boundary means the reset
happens at a different instant for different users, and the same instant is billed to two
different months depending on where the server runs.

---

## Known limitations

Stated rather than hidden. Each has a known fix that was out of scope here.

- If the process dies between the provider returning and the settle transaction committing, a chat
  message stays `PENDING` with the charge applied. **Fix:** a reaper over `PENDING` messages older
  than a timeout.
- A charge with an unknown outcome is reported, not resolved. **Fix:** a gateway lookup by
  reference, which a simulated gateway cannot offer.
- Idempotency records are never pruned. **Fix:** a retention job alongside a real deployment.
- History pagination is a `before` cursor on `created_at`; it does not disambiguate messages
  sharing a timestamp to the microsecond. **Fix:** a composite `(created_at, id)` cursor.

## Deliberately not built

Real OpenAI calls, real payments, authentication, rate limiting, caching, an outbox, a job
scheduler, proration or refunds on cancellation, plan upgrades and downgrades, observability
wiring, or containerising the app itself.

Each of these would be right in production and wrong in a scoped exercise. They are listed because
knowing where a system _stops_ is part of designing it — and because the boundaries above are
exactly where each one would attach.

---

## Tests

70 tests: 36 unit, 34 integration. Not coverage for its own sake — one test per rule the brief
states, plus the races that break metering and billing systems in production.

Unit tests are pure: policy, state machine and date arithmetic, no database. Integration tests run
against real PostgreSQL over real HTTP, because a concurrency guarantee that is only proven against
a mock is not proven. Races are forced deterministically rather than left to chance — a test that
only sometimes exercises the interleave it names is a test that only sometimes exists.

| Test                                            | What breaks if it fails                                           |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| 8 concurrent requests, 1 credit                 | Users consume more than they paid for                             |
| 8 concurrent requests, 1 free message           | Same, on the free path                                            |
| Duplicate `Idempotency-Key`                     | Users are charged twice for one retry                             |
| Simultaneous duplicate keys                     | The double-click case, in flight                                  |
| Same key, different body                        | Silent key reuse corrupts the record                              |
| Keys reused across two users                    | One tenant can observe or block another                           |
| AI provider failure                             | Users pay for answers they never got                              |
| Month rollover with a fixed clock               | The free grant never resets, or resets wrongly                    |
| Bundle selection order                          | The wrong balance is drained; credit expires unused               |
| Unlimited held in reserve                       | Perishable prepaid credit is wasted                               |
| Repeated billing run                            | Subscribers are charged twice for one period                      |
| Concurrent billing runs                         | Same, under a race                                                |
| Declined renewal                                | An unpaid subscription keeps serving                              |
| Gateway timeout during renewal                  | An unknown charge is retried and duplicated                       |
| Cancel, then run billing past `endDate`         | Cancellation deletes history, or service stops early              |
| Duplicate purchase key                          | A user is billed twice for one bundle                             |
| Another user's subscription id                  | Cross-tenant data exposure                                        |
| Month-end and leap-day renewal dates            | Every subsequent renewal date drifts                              |
| Period closed by a database-generated timestamp | Usage history is silently lost on renewal                         |
| Settle fails after the effect committed         | A retry re-runs the work and charges a second time                |
| Superseded claimant settles or releases         | A successor's response is overwritten, or a live claim deleted    |
| Runner overtaken mid-renewal                    | A period is skipped, with no billing row and no charge            |
| Charge for a period the subscription left       | Money moves with no record and no report                          |
| Unreadable or oversized request body            | Client bugs read as server outages; anyone can drive the 5xx rate |
