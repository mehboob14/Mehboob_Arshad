import type { PaymentGateway, PaymentRequest, PaymentResult } from '../domain/payment.js';

/**
 * Stands in for a payment provider, declining a configurable fraction of
 * charges as the brief requires.
 *
 * `random` is injected rather than called directly so that a test can decide
 * the outcome instead of hoping for it: billing behaviour that only appears
 * one time in five is behaviour that never gets tested.
 */
export class SimulatedPaymentGateway implements PaymentGateway {
  constructor(
    private readonly failureRate: number,
    private readonly random: () => number = Math.random,
  ) {}

  charge(request: PaymentRequest): Promise<PaymentResult> {
    if (this.random() < this.failureRate) {
      return Promise.resolve({ outcome: 'DECLINED', reason: 'card_declined' });
    }
    return Promise.resolve({ outcome: 'SUCCEEDED', reference: request.reference });
  }
}
