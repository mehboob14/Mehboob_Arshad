import type { AllowanceCharge } from '../../../shared/domain/allowance.js';

export type ChatMessageStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChatMessageState {
  readonly id: string;
  readonly userId: string;
  readonly question: string;
  readonly answer: string | null;
  readonly status: ChatMessageStatus;
  readonly tokens: TokenUsage | null;
  readonly charge: AllowanceCharge;
  readonly chargeRefunded: boolean;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

/**
 * A single question/answer exchange, and the record of which allowance paid for
 * it. It is created in a PENDING state the moment quota is reserved, before the
 * provider is called, so the charge is never invisible: every deduction has a
 * message that explains it, even if that message never receives an answer.
 */
export class ChatMessage {
  private constructor(private readonly state: ChatMessageState) {}

  static reserve(input: {
    id: string;
    userId: string;
    question: string;
    charge: AllowanceCharge;
    at: Date;
  }): ChatMessage {
    return new ChatMessage({
      id: input.id,
      userId: input.userId,
      question: input.question,
      answer: null,
      status: 'PENDING',
      tokens: null,
      charge: input.charge,
      chargeRefunded: false,
      createdAt: input.at,
      completedAt: null,
    });
  }

  static rehydrate(state: ChatMessageState): ChatMessage {
    return new ChatMessage(state);
  }

  get id(): string {
    return this.state.id;
  }

  get charge(): AllowanceCharge {
    return this.state.charge;
  }

  complete(answer: string, tokens: TokenUsage, at: Date): ChatMessage {
    this.assertPending();
    return new ChatMessage({ ...this.state, status: 'COMPLETED', answer, tokens, completedAt: at });
  }

  /**
   * The provider never answered, so the user is not charged for it. Failure and
   * reimbursement are one transition because they must never diverge.
   */
  failAndRefund(at: Date): ChatMessage {
    this.assertPending();
    return new ChatMessage({
      ...this.state,
      status: 'FAILED',
      chargeRefunded: true,
      completedAt: at,
    });
  }

  snapshot(): ChatMessageState {
    return this.state;
  }

  private assertPending(): void {
    if (this.state.status !== 'PENDING') {
      throw new Error(`Cannot transition a ${this.state.status} message.`);
    }
  }
}
