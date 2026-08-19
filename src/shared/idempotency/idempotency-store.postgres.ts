import type { UnitOfWork } from '../persistence/unit-of-work.js';
import type { ClaimRequest, ClaimResult, IdempotencyStore, SettleRequest } from './idempotency.js';

interface KeyRow {
  request_fingerprint: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  response_status: number | null;
  response_body: unknown;
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: UnitOfWork) {}

  /**
   * The key is *claimed*, not checked. Two concurrent requests both reach the
   * INSERT; the UNIQUE constraint lets exactly one of them through, and that
   * decision is made inside the database with no window between the check and
   * the write. ON CONFLICT DO NOTHING is used rather than catching SQLSTATE
   * 23505 because a raised error would abort any enclosing transaction.
   */
  async claim(request: ClaimRequest): Promise<ClaimResult> {
    // A losing claimant can find the row already released by the winner's
    // rollback; one retry is enough to re-enter the race cleanly.
    for (let attempt = 0; attempt < 2; attempt++) {
      const inserted = await this.db.query<{ id: number }>(
        `INSERT INTO idempotency_keys (user_id, idempotency_key, request_fingerprint, status)
         VALUES ($1, $2, $3, 'PROCESSING')
         ON CONFLICT ON CONSTRAINT idempotency_keys_scope_key DO NOTHING
         RETURNING id`,
        [request.userId, request.key, request.fingerprint],
      );
      if (inserted.length > 0) return { outcome: 'CLAIMED' };

      const [existing] = await this.db.query<KeyRow>(
        `SELECT request_fingerprint, status, response_status, response_body
           FROM idempotency_keys
          WHERE user_id = $1 AND idempotency_key = $2`,
        [request.userId, request.key],
      );
      if (!existing) continue;

      if (existing.request_fingerprint !== request.fingerprint) {
        return { outcome: 'FINGERPRINT_MISMATCH' };
      }
      if (existing.status !== 'PROCESSING') {
        return {
          outcome: 'REPLAY',
          status: existing.response_status ?? 500,
          body: existing.response_body,
        };
      }

      // The original owner may have died before settling. Taking the claim over
      // is itself a conditional UPDATE, so only one retry can win it.
      const takenOver = await this.db.query<{ id: number }>(
        `UPDATE idempotency_keys
            SET claimed_at = now(), updated_at = now()
          WHERE user_id = $1 AND idempotency_key = $2
            AND status = 'PROCESSING' AND claimed_at < $3
          RETURNING id`,
        [request.userId, request.key, request.staleClaimsBefore],
      );
      return takenOver.length > 0 ? { outcome: 'CLAIMED' } : { outcome: 'IN_PROGRESS' };
    }
    return { outcome: 'IN_PROGRESS' };
  }

  async settle(request: SettleRequest): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_keys
          SET status = $3, response_status = $4, response_body = $5, updated_at = now()
        WHERE user_id = $1 AND idempotency_key = $2`,
      [
        request.userId,
        request.key,
        request.status,
        request.responseStatus,
        JSON.stringify(request.responseBody ?? null),
      ],
    );
  }

  async release(userId: string, key: string): Promise<void> {
    await this.db.query(
      `DELETE FROM idempotency_keys
        WHERE user_id = $1 AND idempotency_key = $2 AND status = 'PROCESSING'`,
      [userId, key],
    );
  }
}
