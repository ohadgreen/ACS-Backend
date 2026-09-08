import { ValidationError } from '../errors/domain-error';
import { ErrorCodes } from '../errors/error-codes';

const MINUTE_MS = 60_000;

/**
 * The grid is anchored to the UTC epoch, which makes alignment a pure modulo
 * check and independent of any timezone. For every tick size that divides an
 * hour, this agrees with "minutes are :00/:15/:30/:45" in any real zone.
 */
export function isGridAligned(at: Date, slotMinutes: number): boolean {
  return at.getTime() % (slotMinutes * MINUTE_MS) === 0;
}

/** Enumerates the half-open range [from, to). Both bounds must be aligned. */
export function gridTicks(from: Date, to: Date, slotMinutes: number): Date[] {
  if (!isGridAligned(from, slotMinutes)) {
    throw new ValidationError(
      ErrorCodes.VALIDATION_FAILED,
      'Start is not aligned to the slot grid.',
      { field: 'from', slotMinutes },
    );
  }
  if (!isGridAligned(to, slotMinutes)) {
    throw new ValidationError(
      ErrorCodes.VALIDATION_FAILED,
      'End is not aligned to the slot grid.',
      { field: 'to', slotMinutes },
    );
  }

  const step = slotMinutes * MINUTE_MS;
  const ticks: Date[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += step) {
    ticks.push(new Date(t));
  }
  return ticks;
}
