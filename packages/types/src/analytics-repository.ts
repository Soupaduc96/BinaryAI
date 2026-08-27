import type { AccessScope } from './auth.js';
import type {
  AnalyticsAggregateRow,
  AnalyticsDimension,
  AnalyticsInterval,
  AnalyticsQuery,
  ExclusionReason,
} from './analytics.js';

/**
 * Storage contract for analytics aggregation.
 *
 * Separate from analytics.ts so the vocabulary stays free of repository shape,
 * and separate from the database package so @binaryai/types never depends on an
 * implementation. Every method takes an AccessScope: there is no unscoped read
 * path, which is what makes cross-account aggregation impossible by
 * construction rather than by review.
 */

export interface AnalyticsRepository {
  /** One row covering everything in scope. */
  totals(scope: AccessScope, query?: AnalyticsQuery): Promise<AnalyticsAggregateRow>;
  /** Grouped breakdown along one dimension. */
  byDimension(
    scope: AccessScope,
    dimension: AnalyticsDimension,
    query?: AnalyticsQuery,
  ): Promise<readonly AnalyticsAggregateRow[]>;
  /** One row per confidence bucket, keyed by bucket id. */
  byConfidenceBucket(
    scope: AccessScope,
    boundaries: readonly { id: string; lower: number; upperExclusive: number }[],
    query?: AnalyticsQuery,
  ): Promise<readonly AnalyticsAggregateRow[]>;
  /** Time series, keyed by bucket start as epoch ms. */
  byPeriod(
    scope: AccessScope,
    interval: AnalyticsInterval,
    query?: AnalyticsQuery,
  ): Promise<readonly AnalyticsAggregateRow[]>;
  /** Exclusion tally, so rejected samples are auditable rather than dropped. */
  exclusions(
    scope: AccessScope,
    query?: AnalyticsQuery,
  ): Promise<Readonly<Partial<Record<ExclusionReason, number>>>>;
  /** Earliest and latest settlement in scope; null when nothing has settled. */
  settledRange(
    scope: AccessScope,
    query?: AnalyticsQuery,
  ): Promise<{ first: number | null; last: number | null }>;
  /** Directional signals past expiry with no outcome recorded yet. */
  pendingSettlement(scope: AccessScope): Promise<number>;
  /** Distinct data origins behind the samples in scope. */
  dataOrigins(scope: AccessScope, query?: AnalyticsQuery): Promise<readonly string[]>;
}
