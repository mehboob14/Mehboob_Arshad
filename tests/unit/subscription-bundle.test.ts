import { describe, expect, it } from 'vitest';
import { SubscriptionBundle } from '../../src/modules/subscriptions/domain/subscription-bundle.js';

const START = new Date('2026-08-19T10:00:00Z');
const INSIDE_PERIOD = new Date('2026-09-01T00:00:00Z');
const AFTER_PERIOD = new Date('2026-09-19T10:00:00Z');

function newBundle(autoRenew = true): SubscriptionBundle {
  return SubscriptionBundle.create({
    id: 'sub-1',
    userId: 'user-1',
    tier: 'BASIC',
    billingCycle: 'MONTHLY',
    autoRenew,
    at: START,
  });
}

describe('SubscriptionBundle', () => {
  it('is created unpaid, and an unpaid bundle serves nothing', () => {
    const bundle = newBundle();

    expect(bundle.status).toBe('PENDING_PAYMENT');
    expect(bundle.canServeMessageAt(INSIDE_PERIOD)).toBe(false);
    expect(bundle.snapshot().endDate.toISOString()).toBe('2026-09-19T10:00:00.000Z');
    expect(bundle.snapshot().renewalDate?.toISOString()).toBe('2026-09-19T10:00:00.000Z');
  });

  it('has no renewal date when auto-renew is off', () => {
    expect(newBundle(false).snapshot().renewalDate).toBeNull();
  });

  it('serves messages once the payment succeeds', () => {
    const bundle = newBundle().activate();

    expect(bundle.status).toBe('ACTIVE');
    expect(bundle.canServeMessageAt(INSIDE_PERIOD)).toBe(true);
    expect(bundle.remaining).toBe(10);
  });

  it('stops serving and stops renewing when the payment is declined', () => {
    const bundle = newBundle().declinePayment();

    expect(bundle.status).toBe('PAYMENT_FAILED');
    expect(bundle.canServeMessageAt(INSIDE_PERIOD)).toBe(false);
    expect(bundle.snapshot().autoRenew).toBe(false);
  });

  it('keeps serving after cancellation until the paid period ends', () => {
    const bundle = newBundle().activate().cancel(INSIDE_PERIOD);

    expect(bundle.status).toBe('ACTIVE');
    expect(bundle.isCancelling).toBe(true);
    expect(bundle.canServeMessageAt(INSIDE_PERIOD)).toBe(true);
    expect(bundle.canServeMessageAt(AFTER_PERIOD)).toBe(false);
    expect(bundle.snapshot().autoRenew).toBe(false);
    expect(bundle.snapshot().renewalDate).toBeNull();
  });

  it('refuses to cancel twice', () => {
    const cancelled = newBundle().activate().cancel(INSIDE_PERIOD);

    expect(() => cancelled.cancel(INSIDE_PERIOD)).toThrow(/already cancelled/i);
  });

  it('refuses to re-enable renewal on a cancelled subscription', () => {
    const cancelled = newBundle().activate().cancel(INSIDE_PERIOD);

    expect(() => cancelled.setAutoRenew(true)).toThrow(/cancelled/i);
  });

  it('does not renew a cancelled subscription, and closes it as CANCELLED', () => {
    const cancelled = newBundle().activate().cancel(INSIDE_PERIOD);

    expect(cancelled.isDueAt(AFTER_PERIOD)).toBe(true);
    expect(cancelled.shouldRenewAt(AFTER_PERIOD)).toBe(false);
    expect(cancelled.close().status).toBe('CANCELLED');
  });

  it('closes an uncancelled subscription that simply ran out as EXPIRED', () => {
    expect(newBundle(false).activate().close().status).toBe('EXPIRED');
  });

  it('renews into the next period and resets the message allowance', () => {
    const used = SubscriptionBundle.rehydrate({
      ...newBundle().activate().snapshot(),
      usedMessages: 7,
    });

    const renewed = used.renew();

    expect(renewed.usedMessages).toBe(0);
    expect(renewed.remaining).toBe(10);
    expect(renewed.snapshot().startDate.toISOString()).toBe('2026-09-19T10:00:00.000Z');
    expect(renewed.snapshot().endDate.toISOString()).toBe('2026-10-19T10:00:00.000Z');
  });

  it('refuses a transition that is illegal from the current state', () => {
    expect(() => newBundle().cancel(INSIDE_PERIOD)).toThrow(/PENDING_PAYMENT/);
  });
});
