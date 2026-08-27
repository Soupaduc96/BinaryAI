import { randomUUID } from 'node:crypto';

export function createId(): string {
  return randomUUID();
}

/** Prefixed id, e.g. `sig_1f0c...`, so ids are readable in logs. */
export function createPrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Deterministic id for reproducible artefacts (backtest runs, fixtures).
 * FNV-1a over the input; not cryptographic, and never used for secrets.
 */
export function deterministicId(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
