import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../shared/domain/clock.js';
import type { TransactionManager } from '../../../shared/persistence/unit-of-work.js';
import type { ChatMessageState } from '../domain/chat-message.js';
import { ChatMessage } from '../domain/chat-message.js';
import { AiProviderUnavailableError } from '../domain/errors.js';
import type {
  AiChatProvider,
  AllowanceGate,
  ChatMessageRepository,
  HistoryQuery,
} from '../domain/ports.js';

export interface AskCommand {
  readonly userId: string;
  readonly question: string;
}

export interface AskResult {
  readonly message: ChatMessageState;
  /** Balance left on the allowance that paid for this message; null if unlimited. */
  readonly remaining: number | null;
}

export class ChatService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly messages: ChatMessageRepository,
    private readonly allowances: AllowanceGate,
    private readonly ai: AiChatProvider,
    private readonly clock: Clock,
  ) {}

  /**
   * Reserve, call, settle.
   *
   * The quota is spent and the message is recorded in one transaction *before*
   * the provider is called, so a request can never obtain an answer it did not
   * pay for. The provider call then happens with no transaction open and no row
   * locks held: holding a lock on a user's balance across a network round trip
   * would serialise that user behind the slowest possible dependency, and a
   * provider that hangs would hold the lock until the connection timed out.
   *
   * The cost of releasing early is that a failed call leaves a charge that must
   * be undone, so failure is a compensating transaction rather than a rollback.
   */
  async ask(command: AskCommand): Promise<AskResult> {
    const startedAt = this.clock.now();

    const reserved = await this.transactions.withTransaction(async (uow) => {
      const granted = await this.allowances.consume(uow, command.userId, startedAt);
      const message = ChatMessage.reserve({
        id: randomUUID(),
        userId: command.userId,
        question: command.question,
        charge: granted.charge,
        at: startedAt,
      });
      await this.messages.insert(uow, message);
      return { message, remaining: granted.remaining };
    });

    let completion;
    try {
      completion = await this.ai.complete(command.question);
    } catch {
      await this.compensate(reserved.message);
      throw new AiProviderUnavailableError('The AI provider did not return a response.');
    }

    const completed = reserved.message.complete(
      completion.answer,
      completion.tokens,
      this.clock.now(),
    );
    await this.transactions.withTransaction((uow) => this.messages.update(uow, completed));

    return { message: completed.snapshot(), remaining: reserved.remaining };
  }

  async history(userId: string, query: HistoryQuery): Promise<ChatMessageState[]> {
    const messages = await this.messages.findByUser(userId, query);
    return messages.map((message) => message.snapshot());
  }

  private async compensate(message: ChatMessage): Promise<void> {
    const failed = message.failAndRefund(this.clock.now());
    await this.transactions.withTransaction(async (uow) => {
      await this.messages.update(uow, failed);
      await this.allowances.refund(uow, failed.snapshot().userId, message.charge);
    });
  }
}
