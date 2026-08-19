import type { CalendarMonth } from '../../../shared/domain/calendar-month.js';

/**
 * The free grant for one user in one calendar month. It is an entity keyed by
 * (user, month) rather than a mutable counter on the user, which is what makes
 * the monthly reset automatic: a new month is simply a different entity.
 */
export class FreeAllowance {
  constructor(
    readonly userId: string,
    readonly month: CalendarMonth,
    readonly granted: number,
    readonly used: number,
  ) {}

  get remaining(): number {
    return Math.max(0, this.granted - this.used);
  }

  get hasCapacity(): boolean {
    return this.remaining > 0;
  }

  /** The instant this allowance is replaced by a fresh one. */
  get resetsAt(): Date {
    return this.month.endsAt();
  }
}
