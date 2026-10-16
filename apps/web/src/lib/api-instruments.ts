import { cache } from 'react';
import type { AssetClassStatus, InstrumentStatus, ProviderCapabilities } from '@binaryai/types';
import { getJson, type ApiResult } from './api';

/**
 * Instrument catalogue feeds.
 *
 * Split out of `api.ts` to keep that file under its line budget, and because
 * these three belong together: they are the only endpoints that answer "what
 * instruments exist and what can be done with them".
 *
 * THE SERVER IS AUTHORITATIVE. The browser never constructs an instrument: it
 * renders what these return and sends back a symbol the server already
 * declared. Every entry carries its own availability, so the picker can say why
 * something is unusable rather than hiding it or showing it as if it worked.
 */
export interface InstrumentFeed {
  readonly instruments: readonly InstrumentStatus[];
  readonly assetClasses: readonly AssetClassStatus[];
  readonly total: number;
  /**
   * EVERY instrument the engine analyses, canonical. Empty when disabled.
   *
   * R6: a single string here made the workspace claim one instrument was the
   * only analysed one while the worker ran several.
   */
  readonly analysedSymbols: readonly string[];
}

export interface SingleInstrumentFeed {
  readonly instrument: InstrumentStatus;
}

export interface AssetClassFeed {
  readonly assetClasses: readonly AssetClassStatus[];
  readonly providers: readonly ProviderCapabilities[];
}

/**
 * The catalogue, with availability answered for a TIMEFRAME.
 *
 * D4: passing the workspace timeframe is what makes CHART availability mean
 * "this instrument, at the timeframe on screen" rather than "some timeframe".
 */
export const fetchInstruments = cache((timeframe?: string): Promise<ApiResult<InstrumentFeed>> =>
  getJson<InstrumentFeed>(
    timeframe === undefined
      ? '/v1/instruments'
      : `/v1/instruments?timeframe=${encodeURIComponent(timeframe)}`,
  ),
);

export const fetchInstrument = cache((symbol: string): Promise<ApiResult<SingleInstrumentFeed>> =>
  getJson<SingleInstrumentFeed>(`/v1/instruments/${encodeURIComponent(symbol)}`),
);

export const fetchAssetClasses = cache((): Promise<ApiResult<AssetClassFeed>> =>
  getJson<AssetClassFeed>(`/v1/instruments/asset-classes`),
);
