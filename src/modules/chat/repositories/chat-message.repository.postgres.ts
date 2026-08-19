import type { AllowanceCharge } from '../../../shared/domain/allowance.js';
import type { UnitOfWork } from '../../../shared/persistence/unit-of-work.js';
import type { ChatMessageStatus } from '../domain/chat-message.js';
import { ChatMessage } from '../domain/chat-message.js';
import type { ChatMessageRepository, HistoryQuery } from '../domain/ports.js';

interface MessageRow {
  id: string;
  user_id: string;
  question: string;
  answer: string | null;
  status: ChatMessageStatus;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  charge_source: 'FREE_TIER' | 'BUNDLE';
  charge_bundle_id: string | null;
  charge_period: string | null;
  charge_refunded: boolean;
  created_at: Date;
  completed_at: Date | null;
}

const COLUMNS =
  'id, user_id, question, answer, status, prompt_tokens, completion_tokens, total_tokens, ' +
  'charge_source, charge_bundle_id, charge_period, charge_refunded, created_at, completed_at';

function toCharge(row: MessageRow): AllowanceCharge {
  return row.charge_source === 'BUNDLE'
    ? { source: 'BUNDLE', bundleId: row.charge_bundle_id ?? '' }
    : { source: 'FREE_TIER', period: row.charge_period ?? '' };
}

function toMessage(row: MessageRow): ChatMessage {
  return ChatMessage.rehydrate({
    id: row.id,
    userId: row.user_id,
    question: row.question,
    answer: row.answer,
    status: row.status,
    tokens:
      row.total_tokens === null
        ? null
        : {
            promptTokens: row.prompt_tokens ?? 0,
            completionTokens: row.completion_tokens ?? 0,
            totalTokens: row.total_tokens,
          },
    charge: toCharge(row),
    chargeRefunded: row.charge_refunded,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}

export class PostgresChatMessageRepository implements ChatMessageRepository {
  constructor(private readonly db: UnitOfWork) {}

  async insert(uow: UnitOfWork, message: ChatMessage): Promise<void> {
    const state = message.snapshot();
    await uow.query(
      `INSERT INTO chat_messages
         (id, user_id, question, status, charge_source, charge_bundle_id, charge_period, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        state.id,
        state.userId,
        state.question,
        state.status,
        state.charge.source,
        state.charge.source === 'BUNDLE' ? state.charge.bundleId : null,
        state.charge.source === 'FREE_TIER' ? state.charge.period : null,
        state.createdAt,
      ],
    );
  }

  async update(uow: UnitOfWork, message: ChatMessage): Promise<void> {
    const state = message.snapshot();
    await uow.query(
      `UPDATE chat_messages
          SET answer = $2, status = $3, prompt_tokens = $4, completion_tokens = $5,
              total_tokens = $6, charge_refunded = $7, completed_at = $8
        WHERE id = $1`,
      [
        state.id,
        state.answer,
        state.status,
        state.tokens?.promptTokens ?? null,
        state.tokens?.completionTokens ?? null,
        state.tokens?.totalTokens ?? null,
        state.chargeRefunded,
        state.completedAt,
      ],
    );
  }

  async findByUser(userId: string, query: HistoryQuery): Promise<ChatMessage[]> {
    const rows = await this.db.query<MessageRow>(
      `SELECT ${COLUMNS}
         FROM chat_messages
        WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, query.before ?? null, query.limit],
    );
    return rows.map(toMessage);
  }
}
