import { DateTime } from 'luxon';

/**
 * The only place "today" is computed. Every caller passes the configured
 * BUSINESS_TIMEZONE; nothing anywhere else may use a local Date to decide
 * which day an instant belongs to, or midnight becomes an off-by-one.
 */
export function businessDayBounds(instant: Date, timeZone: string): { start: Date; end: Date } {
  const local = DateTime.fromJSDate(instant, { zone: timeZone });
  const start = local.startOf('day');
  // plus({ days: 1 }) rather than plus({ hours: 24 }) so DST transitions produce
  // a correct 23- or 25-hour day instead of a silently wrong boundary.
  return { start: start.toUTC().toJSDate(), end: start.plus({ days: 1 }).toUTC().toJSDate() };
}

export function isSameBusinessDay(a: Date, b: Date, timeZone: string): boolean {
  return (
    businessDayBounds(a, timeZone).start.getTime() === businessDayBounds(b, timeZone).start.getTime()
  );
}
