import { describe, expect, it } from 'vitest';
import { gridTicks, isGridAligned } from './grid';

const at = (iso: string) => new Date(iso);

describe('isGridAligned', () => {
  it.each([
    '2026-09-06T10:00:00.000Z',
    '2026-09-06T10:15:00.000Z',
    '2026-09-06T10:30:00.000Z',
    '2026-09-06T10:45:00.000Z',
  ])('accepts %s', (iso) => {
    expect(isGridAligned(at(iso), 15)).toBe(true);
  });

  it.each(['2026-09-06T10:07:00.000Z', '2026-09-06T10:15:30.000Z', '2026-09-06T10:15:00.500Z'])(
    'rejects %s',
    (iso) => {
      expect(isGridAligned(at(iso), 15)).toBe(false);
    },
  );

  it('honours a different tick size', () => {
    expect(isGridAligned(at('2026-09-06T10:10:00.000Z'), 10)).toBe(true);
    expect(isGridAligned(at('2026-09-06T10:10:00.000Z'), 15)).toBe(false);
  });
});

describe('gridTicks', () => {
  it('enumerates a half-open range — the end is excluded', () => {
    const ticks = gridTicks(at('2026-09-06T10:00:00.000Z'), at('2026-09-06T11:00:00.000Z'), 15);
    expect(ticks.map((t) => t.toISOString())).toEqual([
      '2026-09-06T10:00:00.000Z',
      '2026-09-06T10:15:00.000Z',
      '2026-09-06T10:30:00.000Z',
      '2026-09-06T10:45:00.000Z',
    ]);
  });

  it('returns one tick for a single-slot window', () => {
    expect(
      gridTicks(at('2026-09-06T10:00:00.000Z'), at('2026-09-06T10:15:00.000Z'), 15),
    ).toHaveLength(1);
  });

  it('returns nothing when the range is empty or inverted', () => {
    expect(gridTicks(at('2026-09-06T10:00:00.000Z'), at('2026-09-06T10:00:00.000Z'), 15)).toEqual(
      [],
    );
    expect(gridTicks(at('2026-09-06T11:00:00.000Z'), at('2026-09-06T10:00:00.000Z'), 15)).toEqual(
      [],
    );
  });

  it('throws when either bound is off-grid', () => {
    expect(() =>
      gridTicks(at('2026-09-06T10:07:00.000Z'), at('2026-09-06T11:00:00.000Z'), 15),
    ).toThrow();
    expect(() =>
      gridTicks(at('2026-09-06T10:00:00.000Z'), at('2026-09-06T11:07:00.000Z'), 15),
    ).toThrow();
  });
});
