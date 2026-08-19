export interface PaymentRequest {
  /**
   * Stable across retries of the same charge. The gateway is expected to treat
   * it as an idempotency key, which is why it is derived from the billing
   * period rather than generated per attempt.
   */
  readonly reference: string;
  readonly userId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly description: string;
}

/**
 * A decline is a result, not an exception: the gateway answered, and the answer
 * was no. Only a gateway that fails to answer at all throws, because only that
 * case leaves the outcome unknown.
 */
export type PaymentResult =
  | { readonly outcome: 'SUCCEEDED'; readonly reference: string }
  | { readonly outcome: 'DECLINED'; readonly reason: string };

export interface PaymentGateway {
  charge(request: PaymentRequest): Promise<PaymentResult>;
}
