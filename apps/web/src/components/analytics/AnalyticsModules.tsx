import type {
  AnalyticsOverviewFeed,
  ApiResult,
  BacktestFeed,
  CalibrationStatus,
  StrategySummary,
} from '@/lib/api';
import { ConfidenceValue, EvidenceBadge, RateValue } from './EvidenceBadge';
import {
  Absent,
  Chip,
  DataPair,
  Dormant,
  Locked,
  ModuleHeader,
  StatRow,
  Surface,
  failureHeadline,
} from '@/components/ui/primitives';

/**
 * Analytical modules — historical work, positioned below the live workspace.
 *
 * These are modules, not dashboard cards: a header rule, a dense readout, and
 * no decoration. Metrics appear only when the API has them; absence is shown as
 * an em dash, never as a zero.
 */

// ------------------------------------------------------------ performance --

export function PerformanceModule({
  analytics,
  calibration,
}: {
  analytics: ApiResult<AnalyticsOverviewFeed>;
  calibration: ApiResult<CalibrationStatus>;
}) {
  if (!analytics.ok) {
    return (
      <Surface aria-labelledby="performance-heading" className="flex flex-col">
        <ModuleHeader label="Performance" id="performance-heading" />
        {analytics.unauthorized ? (
          <Locked
            what="Outcome analytics are scoped to your account."
            // Preserved from the previous treatment: a missing database is a
            // configuration state, and signing in will not create one.
            {...(calibration.ok && !calibration.data.persistenceConfigured
              ? { hint: 'No database configured — outcomes are not being stored.' }
              : {})}
          />
        ) : (
          <div className="px-5 py-5">
            <Dormant
              headline={failureHeadline(analytics)}
              detail={analytics.error}
              hint={
                calibration.ok && !calibration.data.persistenceConfigured
                  ? 'No database configured — outcomes are not being stored.'
                  : undefined
              }
            />
          </div>
        )}
      </Surface>
    );
  }

  const { overview, evidence } = analytics.data;
  const { counts, observedAccuracy } = overview;
  const settled = counts.wins + counts.losses;

  return (
    <Surface aria-labelledby="performance-heading" className="flex flex-col">
      <ModuleHeader
        label="Performance"
        id="performance-heading"
        meta={settled > 0 ? 'observed outcomes' : undefined}
      />
      <div className="flex flex-1 flex-col gap-5 px-5 py-5">
        {settled === 0 && overview.pendingSettlement === 0 ? (
          <Dormant
            headline="No settled outcomes"
            detail="Metrics appear once signals have expired and been settled against exchange data."
            hint={
              calibration.ok && !calibration.data.persistenceConfigured
                ? 'No database configured — outcomes are not being stored.'
                : undefined
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-6 gap-y-5">
              <DataPair
                label="Observed accuracy"
                value={<RateValue rate={observedAccuracy} />}
                size="lg"
              />
              <DataPair label="Settled" value={settled.toLocaleString()} size="lg" />
              <DataPair
                label="Mean confidence"
                value={<ConfidenceValue value={overview.meanConfidence} />}
              />
              <DataPair
                label="Awaiting settlement"
                value={overview.pendingSettlement.toLocaleString()}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="eyebrow">Evidence</span>
              <EvidenceBadge evidence={observedAccuracy.evidence} />
              {counts.ties > 0 ? <Chip>{counts.ties} tie</Chip> : null}
              {counts.skipped > 0 ? <Chip>{counts.skipped} not eligible</Chip> : null}
            </div>

            {/* Says why a number is missing, rather than leaving a bare dash. */}
            {observedAccuracy.value === null ? (
              <p className="text-[12px] leading-relaxed text-text-3">
                {settled === 0
                  ? 'Nothing has settled yet, so no rate can be observed.'
                  : `${settled} settled outcome(s) recorded. At least ${evidence.minimumSampleSize} are required before an accuracy figure is reported.`}
              </p>
            ) : (
              <p className="text-[12px] leading-relaxed text-text-3">
                Directional correctness over settled outcomes. Not a profit figure and not a
                prediction of future results.
              </p>
            )}
          </>
        )}
      </div>
    </Surface>
  );
}

// ------------------------------------------------------------- backtesting --

export function BacktestingModule({ feed }: { feed: ApiResult<BacktestFeed> }) {
  if (!feed.ok) {
    return (
      <Surface aria-labelledby="backtest-heading" className="flex flex-col">
        <ModuleHeader label="Backtesting" id="backtest-heading" />
        <div className="px-5 py-5">
          <Dormant headline={failureHeadline(feed)} detail={feed.error} />
        </div>
      </Surface>
    );
  }

  const { runs } = feed.data;
  const latest = runs[0];

  return (
    <Surface aria-labelledby="backtest-heading" className="flex flex-col">
      <ModuleHeader
        label="Backtesting"
        id="backtest-heading"
        meta={runs.length > 0 ? `${runs.length} run${runs.length === 1 ? '' : 's'}` : undefined}
        action={runs.length > 0 ? <Chip tone="warn">simulation</Chip> : undefined}
      />
      <div className="flex flex-1 flex-col gap-5 px-5 py-5">
        {!latest ? (
          <Dormant
            headline="No backtest runs"
            detail="Run a strategy against a historical dataset to see win rate, return and drawdown."
            hint="POST /v1/backtest/run · npm run backtest:demo"
            hintMono
          />
        ) : (
          <>
            <StatRow>
              <DataPair label="Runs" value={runs.length} size="lg" />
              <DataPair label="Trades" value={latest.trades} size="lg" />
              <DataPair
                label="Win rate"
                value={
                  latest.winRate === null ? <Absent /> : `${(latest.winRate * 100).toFixed(1)}%`
                }
                size="lg"
              />
              <DataPair
                label="Net P&L"
                value={latest.netPnl.toFixed(2)}
                tone={latest.netPnl > 0 ? 'bull' : latest.netPnl < 0 ? 'bear' : 'neutral'}
                size="lg"
              />
            </StatRow>
            <div className="flex flex-col gap-1.5 border-t border-edge pt-4 text-[12px] text-text-3">
              <span>
                Latest: {latest.strategyKey} v{latest.strategyVersion} · {latest.datasetLabel}
              </span>
              <span>
                Source: {latest.datasetSource.replace(/_/g, ' ')} ·{' '}
                {latest.resultType.replace(/_/g, ' ')}
              </span>
            </div>
          </>
        )}
        <p className="mt-auto text-[12px] leading-relaxed text-text-3">
          Historical simulation under stated payout and fill assumptions. Not real trading
          performance.
        </p>
      </div>
    </Surface>
  );
}

// -------------------------------------------------------------- strategies --

export function StrategyRegistryModule({
  strategies,
  activeId,
}: {
  strategies: ApiResult<StrategySummary[]>;
  activeId?: string | undefined;
}) {
  if (!strategies.ok) {
    return (
      <Surface aria-labelledby="strategies-heading" className="flex flex-col">
        <ModuleHeader label="Strategy Registry" id="strategies-heading" />
        <div className="px-5 py-5">
          <Dormant headline={failureHeadline(strategies)} detail={strategies.error} />
        </div>
      </Surface>
    );
  }

  return (
    <Surface aria-labelledby="strategies-heading" className="flex flex-col">
      <ModuleHeader
        label="Strategy Registry"
        id="strategies-heading"
        meta={`${strategies.data.length} registered`}
      />
      <ul className="flex flex-col divide-y divide-edge/70">
        {strategies.data.map((strategy) => {
          const active = strategy.id === activeId;
          return (
            <li key={strategy.id} className="flex flex-col gap-2 px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="flex items-baseline gap-2.5">
                  <span className="text-[14px] font-medium text-text-1">{strategy.name}</span>
                  <span className="tnum text-[11px] text-text-3">v{strategy.version}</span>
                </span>
                <Chip tone={active ? 'bull' : 'neutral'}>{active ? 'active' : 'idle'}</Chip>
              </div>
              <p className="text-[12px] leading-relaxed text-text-3">{strategy.description}</p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-3">
                <span className="tnum">{strategy.parameters.length} parameters</span>
                <span className="tnum">{strategy.requiredHistory} bars min</span>
                <span className="truncate">{strategy.tags.join(' · ')}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </Surface>
  );
}
