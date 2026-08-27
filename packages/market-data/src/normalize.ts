import { normalizeCandleSeries } from '@binaryai/engine';
import type { CandleSeries, ProviderFetchResult } from '@binaryai/types';
import { err, ok, type Result } from '@binaryai/utils';

/**
 * Normalization: provider output -> BinaryAI's canonical `CandleSeries`.
 *
 * This is the only door into the system for external market data. It reuses the
 * engine's existing `normalizeCandleSeries` boundary rather than adding a second
 * parser, so provider data is held to exactly the same schema as a candle posted
 * to the API.
 *
 * Timestamps are epoch milliseconds UTC throughout. Providers that speak
 * seconds, ISO strings or local time are converted in their adapter, never here
 * and never downstream.
 *
 * Nothing is guessed and nothing is repaired. A candle missing a price is
 * rejected by the schema; a candle with a suspicious price is passed through to
 * the quality scan, which records the problem rather than silently correcting a
 * number that a strategy will later trade on.
 */

export interface NormalizedBatch {
  readonly series: CandleSeries;
  readonly providerId: string;
  readonly providerSymbol: string;
  readonly latencyMs: number;
  readonly receivedAt: number;
}

export function normalizeProviderResult(
  result: ProviderFetchResult,
): Result<NormalizedBatch, string[]> {
  const label =
    `${result.meta.providerId}:${result.meta.providerSymbol} ` +
    `(${result.origin} data, received ${new Date(result.meta.receivedAt).toISOString()})`;

  const parsed = normalizeCandleSeries({
    asset: result.symbol,
    timeframe: result.timeframe,
    source: result.source,
    label: label.slice(0, 200),
    candles: result.candles.map((candle) => ({
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      complete: candle.complete,
    })),
  });

  if (!parsed.ok) return err(parsed.error);

  return ok({
    series: parsed.value,
    providerId: result.meta.providerId,
    providerSymbol: result.meta.providerSymbol,
    latencyMs: result.meta.latencyMs,
    receivedAt: result.meta.receivedAt,
  });
}
