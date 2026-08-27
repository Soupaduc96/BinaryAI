import { describe, expect, it } from 'vitest';
import { describeDatabaseConfig, createPostgresDatabase } from './connection.js';
import {
  DatabaseError,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  SQL_STATE,
  toDatabaseError,
} from './executor.js';
import { checksumOf } from './migrator.js';
import {
  asNumericRecord,
  asRecord,
  fromJson,
  toEpochMs,
  toJsonParam,
  toNullableNumber,
  toNumber,
  toTimestamp,
} from './mappers.js';
import { toDataSource, toDirection, toRiskLevel, toTimeframe } from './enums.js';

/** Unit coverage for the parts that need no database connection. */

describe('describeDatabaseConfig', () => {
  it('never exposes credentials', () => {
    const described = describeDatabaseConfig({
      url: 'postgresql://admin:sup3rs3cret@db.internal:5432/binaryai',
    });
    const serialized = JSON.stringify(described);

    expect(serialized).not.toContain('sup3rs3cret');
    expect(serialized).not.toContain('admin');
    expect(described['host']).toBe('db.internal:5432');
    expect(described['database']).toBe('binaryai');
  });

  it('does not throw on a malformed URL', () => {
    expect(() => describeDatabaseConfig({ url: 'not a url' })).not.toThrow();
    expect(describeDatabaseConfig({ url: 'not a url' })['host']).toBe('unparseable');
  });

  it('reports the pool ceiling and statement timeout', () => {
    const described = describeDatabaseConfig({
      url: 'postgresql://u:p@localhost:5432/db',
      maxConnections: 25,
      statementTimeoutMs: 5000,
    });
    expect(described['maxConnections']).toBe(25);
    expect(described['statementTimeoutMs']).toBe(5000);
  });
});

describe('createPostgresDatabase', () => {
  it('rejects an empty connection string rather than failing later', () => {
    expect(() => createPostgresDatabase({ url: '' })).toThrow(DatabaseError);
    expect(() => createPostgresDatabase({ url: '   ' })).toThrow(/DATABASE_URL is empty/);
  });

  it('reports a failed ping instead of throwing', async () => {
    // Port 1 is reserved; nothing will answer. Connection failure must be a
    // false ping, so the readiness probe can report it rather than crash.
    const database = createPostgresDatabase({
      url: 'postgresql://nobody:nothing@127.0.0.1:1/none',
      connectionTimeoutMs: 500,
    });
    expect(await database.ping()).toBe(false);
    await database.close();
  });

  it('refuses queries after close', async () => {
    const database = createPostgresDatabase({
      url: 'postgresql://nobody:nothing@127.0.0.1:1/none',
      connectionTimeoutMs: 500,
    });
    await database.close();
    await expect(database.query('SELECT 1')).rejects.toThrow(/after the pool was closed/);
  });

  it('is safe to close twice', async () => {
    const database = createPostgresDatabase({
      url: 'postgresql://nobody:nothing@127.0.0.1:1/none',
      connectionTimeoutMs: 500,
    });
    await database.close();
    await expect(database.close()).resolves.toBeUndefined();
  });
});

describe('error normalisation', () => {
  it('preserves the SQLSTATE code and constraint name', () => {
    const error = toDatabaseError(
      Object.assign(new Error('duplicate key'), {
        code: SQL_STATE.uniqueViolation,
        constraint: 'users_email_key',
        detail: 'Key (email) already exists.',
      }),
      'INSERT INTO users ...',
    );

    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.code).toBe('23505');
    expect(error.constraint).toBe('users_email_key');
    expect(isUniqueViolation(error)).toBe(true);
    expect(isCheckViolation(error)).toBe(false);
  });

  it('classifies the constraint families the schema relies on', () => {
    const check = toDatabaseError({ code: SQL_STATE.checkViolation, message: 'x' });
    const fk = toDatabaseError({ code: SQL_STATE.foreignKeyViolation, message: 'x' });
    expect(isCheckViolation(check)).toBe(true);
    expect(isForeignKeyViolation(fk)).toBe(true);
    expect(isUniqueViolation(fk)).toBe(false);
  });

  it('handles a non-Error throw without losing the message', () => {
    expect(toDatabaseError('something went wrong').message).toBe('something went wrong');
  });

  it('does not re-wrap an existing DatabaseError', () => {
    const original = new DatabaseError('original');
    expect(toDatabaseError(original)).toBe(original);
  });
});

describe('mappers', () => {
  it('parses NUMERIC returned as a string', () => {
    // The driver returns NUMERIC as text on purpose, to avoid precision loss.
    expect(toNumber('142.27785460')).toBeCloseTo(142.2778546, 8);
    expect(toNullableNumber(null)).toBeNull();
  });

  it('rejects values that are not numbers rather than yielding NaN', () => {
    expect(() => toNumber('abc', 'price')).toThrow(/is not a number/);
    expect(() => toNumber(undefined, 'price')).toThrow(/unexpected type/);
  });

  it('round-trips epoch milliseconds through a Date', () => {
    const at = 1_767_225_600_123;
    expect(toEpochMs(toTimestamp(at))).toBe(at);
    expect(toEpochMs('2026-01-01T00:00:00.000Z')).toBe(Date.UTC(2026, 0, 1));
  });

  it('serialises JSON parameters deterministically', () => {
    expect(toJsonParam({ a: 1 })).toBe('{"a":1}');
    expect(toJsonParam(undefined)).toBe('null');
  });

  it('reads JSON whether the driver parsed it or not', () => {
    expect(fromJson<{ a: number }>('{"a":1}', { a: 0 })).toEqual({ a: 1 });
    expect(fromJson<{ a: number }>({ a: 2 }, { a: 0 })).toEqual({ a: 2 });
    expect(fromJson('not json', { fallback: true })).toEqual({ fallback: true });
    expect(asRecord(null)).toEqual({});
  });

  it('drops non-numeric entries from a numeric map instead of coercing them', () => {
    expect(asNumericRecord({ rsi: 58.4, adx: '31.2', label: 'bullish', missing: null })).toEqual({
      rsi: 58.4,
      adx: 31.2,
    });
  });
});

describe('enum parsing', () => {
  it('accepts known values', () => {
    expect(toTimeframe('1m')).toBe('1m');
    expect(toDirection('call')).toBe('call');
    expect(toRiskLevel('extreme')).toBe('extreme');
  });

  it('falls back only where the domain has an unknown member', () => {
    expect(toDataSource('something_new')).toBe('unknown');
  });

  it('throws on an unrecognised value where there is no safe fallback', () => {
    // Silently coercing an unknown direction would fabricate a trading signal.
    expect(() => toDirection('sideways')).toThrow(/unexpected value/);
    expect(() => toTimeframe('7m')).toThrow(/unexpected value/);
  });
});

describe('migration checksums', () => {
  it('ignores line-ending differences', () => {
    expect(checksumOf('a;\nb;')).toBe(checksumOf('a;\r\nb;'));
  });

  it('ignores surrounding whitespace but not content', () => {
    expect(checksumOf('  SELECT 1;  ')).toBe(checksumOf('SELECT 1;'));
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 2;'));
  });
});
