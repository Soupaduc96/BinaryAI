/**
 * Seeded pseudo-random generator.
 *
 * SCOPE: reproducible test fixtures and clearly-labelled synthetic datasets
 * ONLY. No analysis, signal, confidence or risk code may call this -- those
 * paths must be deterministic functions of market data. See
 * docs/development-principles.md (rules 2 and 3).
 */

export interface SeededRandom {
  /** Uniform in [0, 1). */
  next(): number;
  /** Standard normal via Box-Muller. */
  nextNormal(): number;
}

export function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    nextNormal(): number {
      // Guard against log(0).
      const u1 = next() || Number.EPSILON;
      const u2 = next();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
  };
}
