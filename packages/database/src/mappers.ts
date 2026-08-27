import { DatabaseError } from './executor.js';

/**
 * Row <-> domain conversion.
 *
 * Two driver behaviours make this file necessary rather than incidental:
 *
 *  1. NUMERIC comes back as a STRING. That is correct -- NUMERIC(20,8) can hold
 *     values float64 cannot represent, so the driver refuses to lose precision
 *     silently. Conversion to `number` happens here, explicitly, at the edge.
 *  2. TIMESTAMPTZ comes back as a Date. The domain uses epoch milliseconds
 *     everywhere, so it is converted once here rather than in every repository.
 *
 * JSONB parameters are stringified explicitly and cast with `::jsonb` in the
 * SQL, so behaviour does not depend on a driver's object-serialisation rules.
 */

export function toNumber(value: unknown, field = 'value'): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DatabaseError(`${field} is not finite`);
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new DatabaseError(`${field} "${value}" is not a number`);
    return parsed;
  }
  if (typeof value === 'bigint') return Number(value);
  throw new DatabaseError(`${field} has unexpected type ${typeof value}`);
}

export function toNullableNumber(value: unknown, field = 'value'): number | null {
  return value === null || value === undefined ? null : toNumber(value, field);
}

export function toEpochMs(value: unknown, field = 'timestamp'): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) throw new DatabaseError(`${field} "${value}" is not a date`);
    return parsed;
  }
  throw new DatabaseError(`${field} has unexpected type ${typeof value}`);
}

export function toNullableEpochMs(value: unknown, field = 'timestamp'): number | null {
  return value === null || value === undefined ? null : toEpochMs(value, field);
}

/** Convert an epoch-ms domain value into a driver parameter. */
export function toTimestamp(epochMs: number): Date {
  return new Date(epochMs);
}

export function toText(value: unknown, field = 'value'): string {
  if (typeof value === 'string') return value;
  throw new DatabaseError(`${field} is not a string (got ${typeof value})`);
}

export function toNullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function toBoolean(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

/** JSONB parameter. Always paired with a `::jsonb` cast in the statement. */
export function toJsonParam(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * JSONB result. Drivers may hand back a parsed object or the raw text depending
 * on type-parser configuration, so both are handled.
 */
export function fromJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return fromJson<Record<string, unknown>>(value, {});
}

/**
 * Numeric map from a JSONB aggregate, dropping anything non-numeric rather than
 * coercing it. Used for the calibration read model's market-condition snapshot.
 */
export function asNumericRecord(value: unknown): Record<string, number> {
  const source = asRecord(value);
  const output: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    const parsed = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof parsed === 'number' && Number.isFinite(parsed)) output[key] = parsed;
  }
  return output;
}
