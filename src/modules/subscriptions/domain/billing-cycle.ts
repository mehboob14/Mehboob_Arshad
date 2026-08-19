import type { BillingCycle } from './tier.js';

const MONTHS_IN_CYCLE: Readonly<Record<BillingCycle, number>> = { MONTHLY: 1, YEARLY: 12 };

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * The end of a billing period that starts at `from`.
 *
 * The anniversary day is clamped to the length of the target month, so a
 * subscription started on the 31st bills on the 28th in February and does not
 * silently slide into March — which is what plain month arithmetic does, and
 * which shifts every subsequent renewal by a day.
 */
export function addBillingCycle(from: Date, cycle: BillingCycle): Date {
  const year = from.getUTCFullYear();
  const monthIndex = from.getUTCMonth() + MONTHS_IN_CYCLE[cycle];
  const target = new Date(Date.UTC(year, monthIndex, 1));

  return new Date(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      Math.min(from.getUTCDate(), daysInMonth(target.getUTCFullYear(), target.getUTCMonth())),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}
