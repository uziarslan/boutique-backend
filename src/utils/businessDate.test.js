import { describe, expect, it } from 'vitest';
import { getBusinessDate } from './businessDate.js';

describe('getBusinessDate', () => {
  it('keeps after-midnight activity on the opening date for an overnight outlet', () => {
    const timezone = 'Asia/Karachi';
    const businessDayStart = '09:00';
    const businessDayEnd = '04:00';

    // 18:00 on Sep 1 and 03:00 on Sep 2 in Pakistan.
    expect(getBusinessDate(
      new Date('2026-09-01T13:00:00.000Z'),
      timezone,
      businessDayStart,
      businessDayEnd,
    )).toBe('2026-09-01');
    expect(getBusinessDate(
      new Date('2026-09-01T22:00:00.000Z'),
      timezone,
      businessDayStart,
      businessDayEnd,
    )).toBe('2026-09-01');
  });

  it('rolls over when the configured overnight business day ends', () => {
    expect(getBusinessDate(
      new Date('2026-09-01T23:00:00.000Z'), // 04:00 on Sep 2 in Pakistan
      'Asia/Karachi',
      '09:00',
      '04:00',
    )).toBe('2026-09-02');
  });

  it('does not move after-midnight activity for a same-calendar-day outlet', () => {
    expect(getBusinessDate(
      new Date('2026-09-01T22:00:00.000Z'), // 03:00 on Sep 2 in Pakistan
      'Asia/Karachi',
      '09:00',
      '23:00',
    )).toBe('2026-09-02');
  });
});
