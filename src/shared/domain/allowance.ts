/**
 * Shared kernel between the chat and subscriptions contexts.
 *
 * Chat needs to know *what paid* for a message so the charge can be reversed
 * and so usage history survives the bundle it was drawn from. Subscriptions
 * needs to know the same thing to apply and reverse the deduction. Neither
 * module depends on the other's model; both depend on this contract.
 */
export type AllowanceCharge =
  | { readonly source: 'FREE_TIER'; readonly period: string }
  | { readonly source: 'BUNDLE'; readonly bundleId: string };

export interface GrantedAllowance {
  readonly charge: AllowanceCharge;
  /** Remaining balance on the source after this charge; null means unlimited. */
  readonly remaining: number | null;
}
