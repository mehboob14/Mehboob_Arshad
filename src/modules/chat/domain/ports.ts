import type { AllowanceCharge, GrantedAllowance } from '../../../shared/domain/allowance.js';
import type { UnitOfWork } from '../../../shared/persistence/unit-of-work.js';
import type { ChatMessage, TokenUsage } from './chat-message.js';

export interface AiCompletion {
  readonly answer: string;
  readonly tokens: TokenUsage;
}

export interface AiChatProvider {
  complete(question: string): Promise<AiCompletion>;
}

/**
 * Chat's view of metering. It is stated as a port here — not imported from the
 * subscriptions module — so the chat context depends on the *capability* of
 * being granted an allowance, not on how bundles happen to be modelled.
 */
export interface AllowanceGate {
  consume(uow: UnitOfWork, userId: string, at: Date): Promise<GrantedAllowance>;
  refund(uow: UnitOfWork, userId: string, charge: AllowanceCharge): Promise<void>;
}

export interface HistoryQuery {
  readonly limit: number;
  readonly before?: Date;
}

export interface ChatMessageRepository {
  insert(uow: UnitOfWork, message: ChatMessage): Promise<void>;
  update(uow: UnitOfWork, message: ChatMessage): Promise<void>;
  findByUser(userId: string, query: HistoryQuery): Promise<ChatMessage[]>;
}
