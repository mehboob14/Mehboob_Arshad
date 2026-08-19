import { describe, expect, it } from 'vitest';
import { addBillingCycle } from '../../src/modules/subscriptions/domain/billing-cycle.js';

const iso = (value: string): Date => new Date(value);

describe('addBillingCycle', () => {
  it('advances a monthly cycle by one month, keeping the time of day', () => {
    expect(addBillingCycle(iso('2026-03-15T10:30:00Z'), 'MONTHLY').toISOString()).toBe(
      '2026-04-15T10:30:00.000Z',
    );
  });

  it('advances a yearly cycle by one year', () => {
    expect(addBillingCycle(iso('2026-03-15T10:30:00Z'), 'YEARLY').toISOString()).toBe(
      '2027-03-15T10:30:00.000Z',
    );
  });

  it('clamps to the last day of a shorter month instead of overflowing into the next', () => {
    // Naive month arithmetic turns 31 January into 3 March and shifts every
    // subsequent renewal date with it.
    expect(addBillingCycle(iso('2026-01-31T00:00:00Z'), 'MONTHLY').toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  it('clamps to 29 February in a leap year', () => {
    expect(addBillingCycle(iso('2028-01-31T00:00:00Z'), 'MONTHLY').toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('clamps a leap day to 28 February on the next anniversary', () => {
    expect(addBillingCycle(iso('2028-02-29T00:00:00Z'), 'YEARLY').toISOString()).toBe(
      '2029-02-28T00:00:00.000Z',
    );
  });

  it('rolls the year over from December', () => {
    expect(addBillingCycle(iso('2026-12-05T00:00:00Z'), 'MONTHLY').toISOString()).toBe(
      '2027-01-05T00:00:00.000Z',
    );
  });
});
