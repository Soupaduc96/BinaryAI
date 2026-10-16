import { assetFromInstrument, findInstrument } from '@binaryai/market-data';
import { TIMEFRAMES, type Timeframe } from '@binaryai/types';
import type { ResolvedAnalysisInstrument } from './analysis-loop.js';

/**
 * Turning configuration into instruments the workers can trust.
 *
 * The ONLY supported way to build a `ResolvedAnalysisInstrument`. Everything it
 * contains comes from the server-side catalogue, so canonical symbol, asset
 * class, precision and provider cannot drift apart or be supplied by a caller.
 *
 * WHY EACH ENTRY CARRIES ITS OWN TIMEFRAME (R2). The previous shape was a list
 * of symbols plus ONE global timeframe, which made a perfectly reasonable
 * configuration impossible to express: BTC/USD is served at 1m, AAPL only ever
 * has daily bars. Configuring both forced AAPL onto 1m, where it has no stored
 * candles, so every analysis cycle skipped with `no_candles` — silently, for
 * ever. A timeframe is a property of the instrument being analysed, not of the
 * worker, so it belongs on the entry.
 */

export class UnknownAnalysisInstrumentError extends Error {
  readonly symbol: string;

  constructor(symbol: string, purpose: string) {
    super(
      `"${symbol}" is not in BinaryAI's instrument catalogue and cannot be configured for ` +
        `${purpose}. Configure a catalogue instrument, or add it to the catalogue first.`,
    );
    this.name = 'UnknownAnalysisInstrumentError';
    this.symbol = symbol;
  }
}

export class InvalidPlanEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPlanEntryError';
  }
}

/**
 * One configured instrument, before catalogue resolution.
 *
 * Parsed from `SYMBOL@TIMEFRAME`. The timeframe is optional in the text so an
 * existing single-timeframe deployment keeps working; the caller supplies the
 * default it should inherit.
 */
export interface PlanEntryInput {
  readonly symbol: string;
  readonly timeframe: Timeframe;
}

const TIMEFRAME_SET = new Set<string>(TIMEFRAMES);

/**
 * Parses `BTCUSD@1m,ETHUSD@1m,AAPL@1d` into entries.
 *
 * An entry with no `@` inherits `defaultTimeframe`, which is what keeps a
 * deployment configured the old way behaving exactly as before.
 *
 * Everything here is a REFUSAL rather than a repair. A malformed entry that got
 * dropped would leave the worker analysing less than the operator asked for
 * while reporting itself healthy — the failure mode that takes longest to
 * notice, and the reason this whole module throws instead of skipping.
 */
export function parsePlanEntries(
  configured: string,
  defaultTimeframe: Timeframe,
  setting: string,
): readonly PlanEntryInput[] {
  const entries: PlanEntryInput[] = [];

  for (const raw of configured.split(',')) {
    const text = raw.trim();
    if (text === '') continue;

    const parts = text.split('@');
    if (parts.length > 2) {
      throw new InvalidPlanEntryError(
        `${setting} entry "${text}" is malformed. Use SYMBOL or SYMBOL@TIMEFRAME.`,
      );
    }

    const symbol = (parts[0] ?? '').trim();
    if (symbol === '') {
      throw new InvalidPlanEntryError(`${setting} entry "${text}" has no symbol.`);
    }

    const timeframeText = parts.length === 2 ? (parts[1] ?? '').trim() : '';
    if (parts.length === 2 && timeframeText === '') {
      throw new InvalidPlanEntryError(`${setting} entry "${text}" ends in "@" with no timeframe.`);
    }
    if (timeframeText !== '' && !TIMEFRAME_SET.has(timeframeText)) {
      throw new InvalidPlanEntryError(
        `${setting} entry "${text}" names timeframe "${timeframeText}", which is not a ` +
          `timeframe BinaryAI models. Known: ${[...TIMEFRAME_SET].join(', ')}.`,
      );
    }

    entries.push({
      symbol,
      timeframe: timeframeText === '' ? defaultTimeframe : (timeframeText as Timeframe),
    });
  }

  return entries;
}

/**
 * Resolves one configured entry against the catalogue.
 *
 * Accepts a legacy spelling (`BTC-USD`) and returns the canonical instrument,
 * so an older deployment's configuration keeps working and still produces
 * `BTCUSD` — one instrument, not two.
 *
 * THROWS on an unknown symbol, and on a timeframe the instrument's provider
 * does not serve. Falling back to another timeframe would be the worst
 * available behaviour: the worker would analyse a series the operator never
 * asked for, and nothing would say so.
 */
export function resolveAnalysisInstrument(
  symbol: string,
  timeframe: Timeframe,
  purpose = 'analysis',
): ResolvedAnalysisInstrument {
  const instrument = findInstrument(symbol);
  if (!instrument) throw new UnknownAnalysisInstrumentError(symbol, purpose);

  if (!instrument.supportedTimeframes.includes(timeframe)) {
    throw new InvalidPlanEntryError(
      `${instrument.displaySymbol} is not served at ${timeframe}. Supported: ` +
        `${instrument.supportedTimeframes.join(', ')}.`,
    );
  }

  return {
    symbol: instrument.symbol,
    timeframe,
    asset: assetFromInstrument(instrument),
  };
}

/**
 * Resolves a whole plan.
 *
 * DUPLICATES ARE REJECTED, not collapsed. The key is instrument AND timeframe,
 * because BTCUSD@1m and BTCUSD@1h are two legitimate, different analyses —
 * while BTCUSD@1m twice is a configuration mistake that would produce two
 * competing writes for the same decision bar. Silently de-duplicating would
 * hide the mistake; `BTC-USD@1m,BTCUSD@1m` is the same entry written two ways
 * and is caught because both resolve to the same canonical symbol.
 *
 * Order is preserved, so the worker's behaviour is deterministic.
 */
export function resolvePlan(
  entries: readonly PlanEntryInput[],
  setting: string,
  purpose = 'analysis',
): readonly ResolvedAnalysisInstrument[] {
  const resolved: ResolvedAnalysisInstrument[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const instrument = resolveAnalysisInstrument(entry.symbol, entry.timeframe, purpose);
    const key = `${instrument.symbol}@${instrument.timeframe}`;
    if (seen.has(key)) {
      throw new InvalidPlanEntryError(
        `${setting} names ${key} more than once. Each instrument and timeframe may appear ` +
          'once; two entries for the same pair would produce competing writes for one bar.',
      );
    }
    seen.add(key);
    resolved.push(instrument);
  }

  return resolved;
}

/**
 * Parse and resolve in one step — the shape every caller actually wants.
 *
 * `fallbackSymbol` is used only when the setting is empty, preserving the
 * pre-existing LIVE_ANALYSIS_SYMBOL contract for deployments that never heard
 * of the newer setting.
 */
export function resolvePlanFromConfig(options: {
  readonly configured: string;
  readonly fallbackSymbol: string;
  readonly defaultTimeframe: Timeframe;
  readonly setting: string;
  readonly purpose?: string;
}): readonly ResolvedAnalysisInstrument[] {
  const parsed = parsePlanEntries(options.configured, options.defaultTimeframe, options.setting);
  const entries =
    parsed.length > 0
      ? parsed
      : [{ symbol: options.fallbackSymbol, timeframe: options.defaultTimeframe }];
  return resolvePlan(entries, options.setting, options.purpose ?? 'analysis');
}

/**
 * Kept for callers that hold a plain symbol list and one timeframe.
 *
 * Delegates to `resolvePlan`, so duplicate handling is identical: this no
 * longer silently collapses repeats.
 */
export function resolveAnalysisInstruments(
  symbols: readonly string[],
  timeframe: Timeframe,
): readonly ResolvedAnalysisInstrument[] {
  return resolvePlan(
    symbols.map((symbol) => ({ symbol, timeframe })),
    'ANALYSIS_INSTRUMENTS',
  );
}
