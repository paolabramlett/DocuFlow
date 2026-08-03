import { describe, expect, it } from 'vitest';
import { zonedDayBoundaryToUtc } from '@/lib/time/zoned-day-boundary';

describe('zonedDayBoundaryToUtc', () => {
  it('computes today/tomorrow local midnight for a fixed no-DST-era date (Mexico, post-2022)', () => {
    const now = new Date('2026-08-03T15:00:00Z');
    expect(zonedDayBoundaryToUtc(now, 'America/Mexico_City', 0).toISOString()).toBe('2026-08-03T06:00:00.000Z');
    expect(zonedDayBoundaryToUtc(now, 'America/Mexico_City', 1).toISOString()).toBe('2026-08-04T06:00:00.000Z');
  });

  it('converges correctly during a historical DST-era offset (Mexico observed DST until 2022)', () => {
    // 2015-04-06 fell within Mexico's old DST window (GMT-5), unlike the fixed GMT-6 used today.
    const duringDst = new Date('2015-04-06T15:00:00Z');
    expect(zonedDayBoundaryToUtc(duringDst, 'America/Mexico_City', 0).toISOString()).toBe('2015-04-06T05:00:00.000Z');

    // Same year, before the spring-forward transition — back to GMT-6.
    const beforeDst = new Date('2015-01-15T15:00:00Z');
    expect(zonedDayBoundaryToUtc(beforeDst, 'America/Mexico_City', 0).toISOString()).toBe('2015-01-15T06:00:00.000Z');
  });
});
