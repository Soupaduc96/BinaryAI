/**
 * The SQL execution contract.
 *
 * Repositories depend on `SqlExecutor`, never on `pg`. That is what lets the
 * same repository code run against a pooled server connection, inside a
 * transaction, or against an embedded engine in tests -- and it keeps driver
 * types out of the interfaces in @binaryai/types.
 */

export type Row = Record<string, unknown>;

export interface QueryResult<T extends Row> {
  readonly rows: T[];
  readonly rowCount: number;
}

export interface SqlExecutor {
  query<T extends Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends SqlExecutor {
  /** Runs `work` in a transaction; rolls back on throw. Nesting reuses the outer one. */
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * PostgreSQL SQLSTATE codes worth naming. Callers switch on these rather than
 * matching driver error strings, which differ between drivers and versions.
 */
export const SQL_STATE = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  invalidTextRepresentation: '22P02',
  undefinedTable: '42P01',
  undefinedColumn: '42703',
  duplicateObject: '42710',
} as const;

export type SqlStateCode = (typeof SQL_STATE)[keyof typeof SQL_STATE];

/** One error type for every storage failure, with the driver detail preserved. */
export class DatabaseError extends Error {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly detail: string | undefined;
  readonly statement: string | undefined;

  constructor(
    message: string,
    options: {
      code?: string | undefined;
      constraint?: string | undefined;
      detail?: string | undefined;
      statement?: string | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DatabaseError';
    this.code = options.code;
    this.constraint = options.constraint;
    this.detail = options.detail;
    this.statement = options.statement;
  }
}

/** Narrow an unknown driver error into a DatabaseError without using `any`. */
export function toDatabaseError(error: unknown, statement?: string): DatabaseError {
  if (error instanceof DatabaseError) return error;

  const source =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const message = error instanceof Error ? error.message : String(error);

  return new DatabaseError(message, {
    code: typeof source['code'] === 'string' ? source['code'] : undefined,
    constraint: typeof source['constraint'] === 'string' ? source['constraint'] : undefined,
    detail: typeof source['detail'] === 'string' ? source['detail'] : undefined,
    ...(statement === undefined ? {} : { statement }),
    cause: error,
  });
}

export function hasSqlState(error: unknown, state: SqlStateCode): boolean {
  return error instanceof DatabaseError && error.code === state;
}

export const isUniqueViolation = (error: unknown): boolean =>
  hasSqlState(error, SQL_STATE.uniqueViolation);
export const isForeignKeyViolation = (error: unknown): boolean =>
  hasSqlState(error, SQL_STATE.foreignKeyViolation);
export const isCheckViolation = (error: unknown): boolean =>
  hasSqlState(error, SQL_STATE.checkViolation);
export const isNotNullViolation = (error: unknown): boolean =>
  hasSqlState(error, SQL_STATE.notNullViolation);

/** Raised when a repository is asked about a row that has to exist. */
export class RecordNotFoundError extends DatabaseError {
  constructor(entity: string, identifier: string) {
    super(`${entity} "${identifier}" was not found`);
    this.name = 'RecordNotFoundError';
  }
}
