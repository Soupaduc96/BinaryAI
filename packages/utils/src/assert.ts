/** Thrown when an internal invariant is violated. Never used for user input. */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message);
}

/** Exhaustiveness check for discriminated unions. */
export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new InvariantError(`${message}: ${JSON.stringify(value)}`);
}
