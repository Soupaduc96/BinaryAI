import {
  BacktestingModule,
  PerformanceModule,
  StrategyRegistryModule,
} from '@/components/analytics/AnalyticsModules';
import { CalibrationModule, ObservedBreakdown } from '@/components/analytics/CalibrationModule';
import { WorkspaceHeader } from '@/components/shell/WorkspaceHeader';
import { fetchBacktestRuns, fetchCalibrationStatus, fetchStrategies } from '@/lib/api';
import {
  fetchAnalyticsOverview,
  fetchCalibration,
  fetchStrategyAnalytics,
  fetchRegimeAnalytics,
} from '@/lib/api-analytics';
import { loadDecision, resolveWorkspace, type SearchParams } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * Performance & Analytics.
 *
 * Everything that answers "is any of this any good": measured outcomes, the
 * breakdowns behind them, the calibration report, the strategies that produced
 * them, and historical simulation.
 *
 * This is the only route that touches `/v1/analytics/*`. That matters
 * operationally: those four endpoints used to be fetched on every page view of
 * the single workspace, which exhausted their rate budget in about six
 * navigations. Confining them to the page that displays them is most of why
 * the split is worth doing.
 */
export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // Resolved like every other route, so the decision this page shows belongs
  // to the instrument the workspace is on.
  const context = await resolveWorkspace(await searchParams);
  const scope = context.instrument ?? undefined;
  const scopeLabel = context.selected?.instrument.displaySymbol ?? context.instrument;
  const [
    analytics,
    calibration,
    calibrationReport,
    strategyAnalytics,
    regimeAnalytics,
    strategies,
    backtests,
    decision,
  ] = await Promise.all([
    // D7 — every measured-performance figure is scoped to the workspace
    // instrument. Pooling BTC with EUR/USD produces an accuracy describing
    // neither market, presented beside a workspace that names one.
    fetchAnalyticsOverview(scope),
    fetchCalibrationStatus(),
    fetchCalibration(scope),
    fetchStrategyAnalytics(scope),
    fetchRegimeAnalytics(scope),
    fetchStrategies(),
    fetchBacktestRuns(),
    loadDecision(context),
  ]);

  return (
    <div className="flex flex-col gap-5 px-4 py-5 lg:px-6 lg:py-6">
      <WorkspaceHeader
        eyebrow="Trading"
        title="Pèfòmans ak analitik"
        lede="Presizyon direksyonèl obsève sou siyal ki fin regle. Sa yo se frekans mezire, se pa prediksyon ajiste, epi okenn chif isit la se pa yon pwofi, yon retou espere, ni yon deklarasyon sou rezilta fiti."
        {...(scopeLabel === null ? {} : { meta: `${scopeLabel} only` })}
      />

      {/* The scope, stated once and loudly. Every measured figure below
          describes THIS instrument; a pooled number would describe none of
          them, and nothing on the page would say so. */}
      {scopeLabel === null ? null : (
        <p className="text-[12px] leading-relaxed text-text-3">
          Every measured figure on this page is scoped to{' '}
          <strong className="font-medium text-text-2">{scopeLabel}</strong>. Account balance,
          exposure and the ledger are account-wide and live in Paper Trading and Ledger.
        </p>
      )}

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <PerformanceModule analytics={analytics} calibration={calibration} />
        <ObservedBreakdown
          label="Strategy"
          feed={strategyAnalytics}
          emptyDetail="Presizyon pa estrateji parèt yon fwa siyal yon estrateji fin regle."
        />
        <ObservedBreakdown
          label="Regime"
          feed={regimeAnalytics}
          emptyDetail="Presizyon pa rejim parèt yon fwa siyal yo deside nan yon rejim fin regle."
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <CalibrationModule feed={calibrationReport} />
        <StrategyRegistryModule
          strategies={strategies}
          activeId={decision.detail?.signal.strategy.id}
        />
      </div>

      <BacktestingModule feed={backtests} />
    </div>
  );
}
