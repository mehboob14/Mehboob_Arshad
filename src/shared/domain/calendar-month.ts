const KEY_PATTERN = /^\d{4}-\d{2}$/;

/**
 * The free-tier accounting period. Identity is the UTC calendar month, so the
 * monthly reset is a consequence of the key changing rather than of a job
 * mutating rows at midnight on the 1st.
 */
export class CalendarMonth {
  private constructor(readonly key: string) {}

  static from(instant: Date): CalendarMonth {
    const year = instant.getUTCFullYear().toString().padStart(4, '0');
    const month = (instant.getUTCMonth() + 1).toString().padStart(2, '0');
    return new CalendarMonth(`${year}-${month}`);
  }

  static fromKey(key: string): CalendarMonth {
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid calendar month key: ${key}`);
    return new CalendarMonth(key);
  }

  /** Start of the following month, i.e. the instant the free allowance renews. */
  endsAt(): Date {
    const [year, month] = this.key.split('-').map(Number) as [number, number];
    return new Date(Date.UTC(year, month, 1));
  }

  equals(other: CalendarMonth): boolean {
    return this.key === other.key;
  }
}
