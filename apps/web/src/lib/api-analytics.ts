import { cache } from 'react';
import { getJson, type ApiResult } from './api';
import type { AnalyticsGroupFeed, AnalyticsOverviewFeed, CalibrationFeed } from './api';
/**
 * D7 — analytics scope.
 *
 * Not every figure here is per-instrument, and splitting the ones that are not
 * would be its own dishonesty. The division applied:
 *
 *   INSTRUMENT-SPECIFIC  observed accuracy, per-regime and per-strategy
 *                        breakdowns, calibration — these measure how the engine
 *                        performed ON a market, and pooling BTC with EUR/USD
 *                        produces a number describing neither.
 *   ACCOUNT-WIDE         balance, exposure, open positions, the ledger. One
 *                        account has one balance; scoping it per instrument
 *                        would invent a figure that does not exist.
 *
 * The scope is passed explicitly so a caller cannot get a pooled figure by
 * forgetting, and the UI labels which instrument a figure describes.
 */
/** Appends ?asset= when an instrument scope is supplied. */
function scopedPath(path: string, assetSymbol?: string): string {
  return assetSymbol === undefined ? path : `${path}?asset=${encodeURIComponent(assetSymbol)}`;
}

export const fetchAnalyticsOverview = cache(
  (assetSymbol?: string): Promise<ApiResult<AnalyticsOverviewFeed>> =>
    getJson<AnalyticsOverviewFeed>(scopedPath('/v1/analytics/overview', assetSymbol)),
);

export const fetchCalibration = cache((assetSymbol?: string): Promise<ApiResult<CalibrationFeed>> =>
  getJson<CalibrationFeed>(scopedPath('/v1/analytics/calibration', assetSymbol)),
);

export const fetchStrategyAnalytics = cache(
  (assetSymbol?: string): Promise<ApiResult<AnalyticsGroupFeed>> =>
    getJson<AnalyticsGroupFeed>(scopedPath('/v1/analytics/strategies', assetSymbol)),
);

export const fetchRegimeAnalytics = cache(
  (assetSymbol?: string): Promise<ApiResult<AnalyticsGroupFeed>> =>
    getJson<AnalyticsGroupFeed>(scopedPath('/v1/analytics/regimes', assetSymbol)),
);
