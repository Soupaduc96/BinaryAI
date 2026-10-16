import {
  ANALYTICS_VERSION,
  CONFIDENCE_BUCKETS,
  DEFAULT_EVIDENCE_THRESHOLDS,
  SAMPLE_DEFINITION_VERSION,
  SETTLEMENT_SEMANTICS,
  bucketBounds,
  buildBuckets,
  buildCalibrationReport,
  buildGroups,
  buildPeriods,
  countsFrom,
  decidedOutcomes,
  meanConfidence,
  observedAccuracy,
  suggestInterval,
} from '@binaryai/analytics';
import type {
  AccessScope,
  AnalyticsDimension,
  AnalyticsGroup,
  AnalyticsInterval,
  AnalyticsOverview,
  AnalyticsPeriod,
  AnalyticsProvenance,
  AnalyticsQuery,
  CalibrationReport,
  EvidenceThresholds,
  MarketDataSource,
  Repositories,
} from '@binaryai/types';

/**
 * Analytics composition.
 *
 * Joins two halves that are deliberately kept apart: the repository counts
 * (SQL, scoped, bounded) and @binaryai/analytics derives (rates, evidence
 * levels, calibration measures — pure and unit-tested). Nothing in a route
 * handler computes a statistic; that is the boundary §34 asks for, and it also
 * means the honesty rules cannot be bypassed by a new endpoint.
 *
 * Every method takes an `AccessScope` and threads it into the query. There is
 * no default and no unscoped path.
 */

export interface AnalyticsService {
  overview(scope: AccessScope, query?: AnalyticsQuery): Promise<AnalyticsOverview>;
  byDimension(
    scope: AccessScope,
    dimension: AnalyticsDimension,
    query?: AnalyticsQuery,
  ): Promise<{ groups: readonly AnalyticsGroup[]; provenance: AnalyticsProvenance }>;
  calibration(
    scope: AccessScope,
    query?: AnalyticsQuery,
  ): Promise<{ report: CalibrationReport; provenance: AnalyticsProvenance }>;
  timeseries(
    scope: AccessScope,
    interval: AnalyticsInterval | 'auto',
    query?: AnalyticsQuery,
  ): Promise<{
    interval: AnalyticsInterval;
    periods: readonly AnalyticsPeriod[];
    provenance: AnalyticsProvenance;
  }>;
}

export interface AnalyticsServiceDeps {
  readonly repositories: Repositories;
  readonly thresholds?: EvidenceThresholds;
  readonly now?: () => number;
}

/** Describes the scope in a response without revealing another account's id. */
function describeScope(scope: AccessScope): string {
  switch (scope.kind) {
    case 'all':
      return 'all';
    case 'system':
      return 'system';
    case 'account':
      // The KIND is disclosed, never the account id. A response that echoed the
      // id would leak it into logs and caches for no benefit.
      return scope.includeSystem ? 'account+system' : 'account';
  }
}

export function createAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const { repositories, now = Date.now } = deps;
  const thresholds = deps.thresholds ?? DEFAULT_EVIDENCE_THRESHOLDS;
  const analytics = repositories.analytics;

  async function provenanceFor(
    scope: AccessScope,
    query: AnalyticsQuery,
  ): Promise<AnalyticsProvenance> {
    const origins = await analytics.dataOrigins(scope, query);
    return {
      generatedAt: now(),
      methodologyVersion: ANALYTICS_VERSION,
      sampleDefinitionVersion: SAMPLE_DEFINITION_VERSION,
      scope: describeScope(scope),
      // Echoed from the samples actually counted, so a response can never imply
      // exchange provenance for data that came from somewhere else.
      dataOrigins: origins as readonly MarketDataSource[],
      settlementSemantics: SETTLEMENT_SEMANTICS,
      range: { from: query.from ?? null, to: query.to ?? null },
      // R5. Taken from the query the service actually ran, which the ROUTE
      // resolved through the catalogue — so a stored report always names the
      // instrument it measured, and can never take that name from caller text.
      assetSymbol: query.assetSymbol ?? null,
      instrumentScope: query.assetSymbol === undefined ? 'all_instruments' : 'instrument',
    };
  }

  return {
    async overview(scope, query = {}): Promise<AnalyticsOverview> {
      const [row, range, pending, provenance] = await Promise.all([
        analytics.totals(scope, query),
        analytics.settledRange(scope, query),
        analytics.pendingSettlement(scope),
        provenanceFor(scope, query),
      ]);

      const counts = countsFrom(row);
      return {
        counts,
        observedAccuracy: observedAccuracy(counts, thresholds),
        meanConfidence: meanConfidence(row.confidenceSum, row.confidenceCount),
        settledSamples: decidedOutcomes(counts) + counts.ties,
        pendingSettlement: pending,
        firstSettledAt: range.first,
        lastSettledAt: range.last,
        provenance,
      };
    },

    async byDimension(scope, dimension, query = {}) {
      const [rows, provenance] = await Promise.all([
        analytics.byDimension(scope, dimension, query),
        provenanceFor(scope, query),
      ]);
      return { groups: buildGroups(rows, { thresholds }), provenance };
    },

    async calibration(scope, query = {}) {
      const boundaries = CONFIDENCE_BUCKETS.map((bucket) => ({
        id: bucket.id,
        ...bucketBounds(bucket),
      }));

      const [bucketRows, totals, exclusions, provenance] = await Promise.all([
        analytics.byConfidenceBucket(scope, boundaries, query),
        analytics.totals(scope, query),
        analytics.exclusions(scope, query),
        provenanceFor(scope, query),
      ]);

      const counts = countsFrom(totals);
      const report = buildCalibrationReport({
        buckets: buildBuckets(bucketRows, thresholds),
        // Eligible means: settled, accepted, directional, and complete enough to
        // measure. Ties are settled but carry no directional verdict, so they
        // are counted separately and excluded from the eligible total.
        eligibleSamples: decidedOutcomes(counts),
        settledSamples: decidedOutcomes(counts) + counts.ties + counts.unresolved,
        exclusions,
        generatedAt: now(),
        thresholds,
      });

      return { report, provenance };
    },

    async timeseries(scope, interval, query = {}) {
      const [range, totals] = await Promise.all([
        analytics.settledRange(scope, query),
        analytics.totals(scope, query),
      ]);

      // 'auto' widens the bucket when observations are sparse. A day-by-day
      // chart of twelve outcomes is twelve buckets of one, every one below any
      // reporting threshold -- accurate and useless.
      const resolved: AnalyticsInterval =
        interval === 'auto'
          ? suggestInterval(
              decidedOutcomes(countsFrom(totals)),
              range.first !== null && range.last !== null ? range.last - range.first : 0,
            )
          : interval;

      const [rows, provenance] = await Promise.all([
        analytics.byPeriod(scope, resolved, query),
        provenanceFor(scope, query),
      ]);

      return { interval: resolved, periods: buildPeriods(rows, thresholds), provenance };
    },
  };
}
