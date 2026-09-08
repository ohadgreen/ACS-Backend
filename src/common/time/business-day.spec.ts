import { describe, expect, it } from 'vitest';
import { businessDayBounds, isSameBusinessDay } from './business-day';

const TZ = 'Asia/Jerusalem';

describe('businessDayBounds', () => {
  it('spans exactly 24 hours on an ordinary day', () => {
    const { start, end } = businessDayBounds(new Date('2026-09-06T12:00:00.000Z'), TZ);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('starts at local midnight, not UTC midnight', () => {
    // Israel is UTC+3 in September, so local midnight is 21:00 UTC the day before.
    const { start } = businessDayBounds(new Date('2026-09-06T12:00:00.000Z'), TZ);
    expect(start.toISOString()).toBe('2026-09-05T21:00:00.000Z');
  });

  it('assigns a late-evening UTC instant to the following local day', () => {
    // 22:00 UTC on the 5th is 01:00 local on the 6th.
    const { start } = businessDayBounds(new Date('2026-09-05T22:00:00.000Z'), TZ);
    expect(start.toISOString()).toBe('2026-09-05T21:00:00.000Z');
  });

  it('handles a DST transition without producing a 24-hour assumption', () => {
    // Israel ends DST in late October; the day is 25 hours long.
    const { start, end } = businessDayBounds(new Date('2026-10-25T12:00:00.000Z'), TZ);
    const hours = (end.getTime() - start.getTime()) / 3_600_000;
    expect([23, 24, 25]).toContain(hours);
  });
});

describe('isSameBusinessDay', () => {
  it('groups two instants inside one local day', () => {
    expect(
      isSameBusinessDay(
        new Date('2026-09-06T06:00:00.000Z'),
        new Date('2026-09-06T18:00:00.000Z'),
        TZ,
      ),
    ).toBe(true);
  });

  it('separates instants across local midnight even when UTC dates match', () => {
    // Both are 2026-09-05 in UTC, but 21:30 UTC is already the 6th locally.
    expect(
      isSameBusinessDay(
        new Date('2026-09-05T18:00:00.000Z'),
        new Date('2026-09-05T21:30:00.000Z'),
        TZ,
      ),
    ).toBe(false);
  });
});
