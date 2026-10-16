/**
 * The instrument resolution rule, as a pure function.
 *
 * `resolveWorkspace` does the fetching and calls this; `CommandBar` is a client
 * component that already has the data and calls the same function. That is the
 * point — the rule lives in ONE place.
 *
 * The bug this prevents actually happened twice. The layout once resolved the
 * instrument from the stored-asset list while the page resolved it from
 * `?asset=`, so the command bar and the chart named different instruments on
 * the same screen. Re-deriving "which instrument" anywhere else is how that
 * returns.
 *
 * No server-only imports here, deliberately: this module has to be reachable
 * from both sides of the server/client boundary.
 */

export interface SelectableInstrument {
  readonly symbol: string;
  /** Presentation form, e.g. `BTC/USD`. */
  readonly display: string;
}

/**
 * Picks the instrument in view.
 *
 *  1. The requested symbol, when the CATALOGUE knows it. Asking for a known
 *     instrument that has not been ingested is legitimate — it should show that
 *     instrument with an empty chart, not silently substitute another.
 *  2. The first stored instrument, so a fresh workspace opens on something real.
 *  3. The first catalogue entry, so there is a subject even on an empty database.
 *
 * Returns null rather than guessing when nothing resolves. Substituting a
 * different instrument is how a user reads BTC while believing it is gold.
 */
export function pickInstrument(
  requested: string | null,
  stored: readonly SelectableInstrument[],
  catalogue: readonly SelectableInstrument[],
): SelectableInstrument | null {
  if (requested !== null) {
    const match = catalogue.find((entry) => entry.symbol === requested);
    if (match) return match;
  }

  const firstStored = stored[0];
  if (firstStored) {
    // Prefer the catalogue's display form, so a row stored under a legacy
    // spelling still renders as BTC/USD rather than BTC-USD.
    return catalogue.find((entry) => entry.symbol === firstStored.symbol) ?? firstStored;
  }

  return catalogue[0] ?? null;
}
