import {
  TIMEFRAME_SECONDS,
  type AssetClass,
  type MarketDataSource,
  type MarketRegime,
  type RiskLevel,
  type SignalDirection,
  type SignalFeatureKind,
  type SignalOutcome,
  type SignalRecommendation,
  type SignalStatus,
  type Timeframe,
} from '@binaryai/types';
import { DatabaseError } from './executor.js';

/**
 * Typed reads of PostgreSQL enum and text columns.
 *
 * A column typed `TEXT` in SQL is `string` in the driver, and casting it to a
 * union type would be a lie the compiler happily accepts. These parsers check
 * the value instead. Where the domain has a sensible unknown member the parser
 * falls back to it; where it does not, an unrecognised value is a real data
 * problem and throws.
 */

function parse<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  fallback?: T,
): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  if (fallback !== undefined) return fallback;
  throw new DatabaseError(
    `${field} has unexpected value ${JSON.stringify(value)} (expected one of: ${allowed.join(', ')})`,
  );
}

const TIMEFRAMES_LIST = Object.keys(TIMEFRAME_SECONDS) as Timeframe[];

export const toTimeframe = (value: unknown): Timeframe =>
  parse(value, TIMEFRAMES_LIST, 'timeframe');

export const toAssetClass = (value: unknown): AssetClass =>
  parse(
    value,
    ['forex', 'crypto', 'commodity', 'index', 'stock', 'otc', 'unknown'] as const,
    'asset_class',
    'unknown',
  );

export const toDataSource = (value: unknown): MarketDataSource =>
  parse(
    value,
    ['live_provider', 'historical_provider', 'historical_file', 'synthetic', 'unknown'] as const,
    'data_source',
    'unknown',
  );

export const toDirection = (value: unknown): SignalDirection =>
  parse(value, ['call', 'put', 'none'] as const, 'direction');

export const toRegime = (value: unknown): MarketRegime =>
  parse(
    value,
    ['trend_up', 'trend_down', 'range', 'volatile', 'quiet', 'unknown'] as const,
    'market_regime',
    'unknown',
  );

export const toRiskLevel = (value: unknown): RiskLevel =>
  parse(value, ['low', 'medium', 'high', 'extreme'] as const, 'risk_level');

export const toSignalStatus = (value: unknown): SignalStatus =>
  parse(
    value,
    ['candidate', 'accepted', 'rejected', 'expired', 'settled', 'cancelled'] as const,
    'status',
  );

export const toRecommendation = (value: unknown): SignalRecommendation =>
  parse(value, ['consider', 'wait_for_confirmation', 'skip'] as const, 'recommendation');

export const toOutcomeResult = (value: unknown): SignalOutcome['result'] =>
  parse(value, ['win', 'loss', 'tie', 'unresolved'] as const, 'result');

export const toFeatureKind = (value: unknown): SignalFeatureKind =>
  parse(
    value,
    ['indicator', 'confirmation', 'conflict', 'confidence_component'] as const,
    'feature kind',
  );
