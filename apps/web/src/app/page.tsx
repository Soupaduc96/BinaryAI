import type { CandleSeries, PersistedSignal } from '@binaryai/types';
import {
  BacktestingModule,
  PerformanceModule,
  StrategyRegistryModule,
} from '@/components/analytics/AnalyticsModules';
import { CalibrationModule, ObservedBreakdown } from '@/components/analytics/CalibrationModule';
import { AccountRiskModule, PaperAccountModule } from '@/components/account/PaperWorkspace';
import { PaperSimulationModule } from '@/components/account/PaperSimulation';
import { LedgerSummaryModule, RecentPositionsModule } from '@/components/account/AccountModules';
import { ActivePositionModule } from '@/components/account/ActivePosition';
import {
  AccountOverviewModule,
  RiskAssessmentModule,
  SystemStatusModule,
} from '@/components/workspace/RightRail';
import { SystemHealthStrip } from '@/components/system/SystemHealthStrip';
import { AnalysisMatrix } from '@/components/workspace/AnalysisMatrix';
import { DecisionPanel } from '@/components/workspace/DecisionPanel';
import { MarketCanvas } from '@/components/workspace/MarketCanvas';
import { MarketContextStrip } from '@/components/workspace/MarketContextStrip';
import { SignalIntelligence } from '@/components/workspace/SignalIntelligence';
import { PaperActionPanel } from '@/components/workspace/PaperActionPanel';
import { readTimeframe } from '@/lib/timeframe';
import { computeIndicatorLines, readIndicators, readOverlays } from '@/lib/chart-overlays';
import {
  fetchAnalyticsOverview,
  fetchAuthContext,
  fetchAssets,
  fetchPaperAccount,
  fetchPositions,
  fetchRiskEvents,
  fetchRiskPolicy,
  fetchSimulation,
  fetchSimulationModels,
  fetchCalibration,
  fetchRegimeAnalytics,
  fetchStrategyAnalytics,
  fetchBacktestRuns,
  fetchCalibrationStatus,
  fetchCandles,
  fetchMarketDataStatus,
  fetchSignalDetail,
  fetchSignals,
  fetchStrategies,
  fetchSystemStatus,
} from '@/lib/api';
import { fetchActionability } from '@/lib/api-risk';

// Read per request. A cached "market offline" state would be worse than none.
export const dynamic = 'force-dynamic';

/**
 * The market intelligence workspace.
 *
 *   MARKET  ->  ANALYSIS  ->  AI INTERPRETATION  ->  DECISION  ->  RISK
 *
 * The instrument and timeframe are resolved from stored data and the URL, not
 * assumed: with nothing ingested the workspace stays dormant and says why,
 * rather than defaulting to a symbol BinaryAI holds no candles for.
 */
export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const timeframe = readTimeframe(params['tf']);

  const [
    status,
    strategies,
    signals,
    backtests,
    calibration,
    marketData,
    assets,
    analytics,
    calibrationReport,
    strategyAnalytics,
    regimeAnalytics,
    paperAccount,
    riskPolicy,
    positions,
    riskEvents,
    authContext,
    simulated,
    simulationModels,
  ] = await Promise.all([
    fetchSystemStatus(),
    fetchStrategies(),
    fetchSignals(),
    fetchBacktestRuns(),
    fetchCalibrationStatus(),
    fetchMarketDataStatus(),
    fetchAssets(),
    fetchAnalyticsOverview(),
    fetchCalibration(),
    fetchStrategyAnalytics(),
    fetchRegimeAnalytics(),
    fetchPaperAccount(),
    fetchRiskPolicy(),
    fetchPositions(),
    fetchRiskEvents(),
    fetchAuthContext(),
    fetchSimulation(),
    fetchSimulationModels(),
  ]);

  // The active instrument is whichever one BinaryAI actually holds data for.
  // `?asset=` overrides it; an unknown symbol simply yields no candles and the
  // canvas explains that rather than inventing a series.
  const storedAssets = assets.ok ? assets.data.assets : [];
  const requested = params['asset'];
  const requestedSymbol = Array.isArray(requested) ? requested[0] : requested;
  const instrument =
    storedAssets.find((asset) => asset.symbol === requestedSymbol)?.symbol ??
    storedAssets[0]?.symbol ??
    null;

  let series: CandleSeries | null = null;
  let candleReason: string | undefined;
  if (instrument) {
    const candles = await fetchCandles(instrument, timeframe);
    if (candles.ok) {
      series = candles.data.series;
      candleReason = candles.data.reason;
    } else {
      candleReason = candles.error;
    }
  } else {
    candleReason = assets.ok
      ? assets.data.reason
      : 'The dashboard cannot reach the API to list instruments.';
  }

  // The full decision is fetched only when a signal exists. With no analysis
  // there is nothing to fetch and nothing to invent.
  let detail: PersistedSignal | null = null;
  const latest = signals.ok ? signals.data.signals[0] : undefined;

  // Chart overlays. Selection comes from the URL, the values come from the
  // candles already fetched above — no second request and no separate source,
  // so a line can never disagree with the bars beneath it.
  const selectedIndicators = readIndicators(params['ind']);
  const selectedOverlays = readOverlays(params['ov']);
  const indicatorLines = computeIndicatorLines(series?.candles ?? [], selectedIndicators);
  // Markers are drawn only for signals recorded on THIS instrument and
  // timeframe; a decision made on another series is not a mark on this one.
  const signalMarkers =
    selectedOverlays.includes('signals') && signals.ok
      ? signals.data.signals
          .filter(
            (signal) =>
              signal.timeframe === timeframe &&
              (instrument === null || signal.assetSymbol === instrument) &&
              (signal.direction === 'call' || signal.direction === 'put'),
          )
          .map((signal) => ({
            at: signal.decidedAt,
            direction: signal.direction as 'call' | 'put',
            status: signal.status,
          }))
      : [];
  if (latest) {
    const result = await fetchSignalDetail(latest.id);
    if (result.ok) detail = result.data;
  }
  // The persisted identifier. See the note above: NEVER detail.signal.id.
  const signalId = latest?.id ?? null;

  /**
   * Everything the paper-action step needs, resolved here so the panel renders
   * one coherent state rather than assembling it from four half-loaded feeds.
   *
   * `actionability` is a SERVER-SIDE risk evaluation: the workspace states
   * whether an action is possible using the engine's own verdict, rather than
   * reconstructing one in the browser from account numbers that might disagree
   * with the policy actually in force.
   */
  const signedIn = authContext.ok && authContext.data.authenticated;
  // A locked risk module is one line tall; the layout below reacts to that
  // rather than pairing it with a full-height decision panel.
  const riskLocked = !riskPolicy.ok && riskPolicy.unauthorized === true;

  const capacity =
    paperAccount.ok && riskPolicy.ok
      ? {
          availableUnits: paperAccount.data.paper.availableUnits,
          committedUnits: paperAccount.data.paper.committedUnits,
          openPositions: paperAccount.data.paper.openPositions,
          maxOpenPositions: riskPolicy.data.policy.limits.maxOpenPositions,
          maxPositionSize: riskPolicy.data.policy.maxPositionSize,
        }
      : null;

  const activeModel = simulated.ok ? simulated.data.simulation.model : null;

  // A position already opened on the signal in view. Found by signal id, so the
  // panel reports the real position rather than assuming one from local state.
  const signalPosition =
    signalId && positions.ok
      ? (positions.data.positions.find((entry) => entry.signalId === signalId) ?? null)
      : null;

  // Only asked when it can be answered: an accepted signal, a signed-in user,
  // and no position already open on it.
  const actionability =
    signedIn && signalId && detail?.signal.status === 'accepted' && !signalPosition
      ? await fetchActionability(signalId)
      : null;

  return (
    <>
      <MarketContextStrip
        marketData={marketData}
        timeframe={timeframe}
        instrument={instrument}
        series={series}
      />

      <div className="flex flex-col gap-5 px-4 py-5 lg:px-6 lg:py-6">
        {/*
          The workspace: three zones.

          SIDEBAR  product navigation (in the shell)
          MAIN     what the market did and what BinaryAI makes of it — chart,
                   decision, risk, the action, and the record of signals
          RAIL     account state — what this account holds, what is live in it,
                   what it has done, and whether the platform is healthy

          The rail is persistent rather than a section further down the page,
          because account state is context a user reads WHILE looking at the
          decision, not afterwards. Below lg the rail folds under the main
          column and the decision leads, since that is what a phone is opened
          for.
        */}
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px] 2xl:grid-cols-[minmax(0,1fr)_420px]">
          {/* ============================================== main workspace == */}
          <div className="flex min-w-0 flex-col gap-5">
            {/* order-2 below lg: on a phone the decision leads, because that is
                what the app is opened to read. The chart follows it, and the
                action follows the chart. From lg the source order returns. */}
            <div
              id="section-chart"
              className="order-2 flex min-w-0 flex-col scroll-mt-24 lg:order-none"
            >
              <MarketCanvas
                series={series}
                reason={candleReason}
                instrument={instrument ?? undefined}
                supportedTimeframes={
                  marketData.ok
                    ? (marketData.data.provider?.supportedTimeframes ?? undefined)
                    : undefined
                }
                indicatorLines={indicatorLines}
                markers={signalMarkers}
                showLastPrice={selectedOverlays.includes('last')}
              />
            </div>

            {/* The verdict and the limits that qualify it, side by side. */}
            {/*
              items-start: risk is a short module beside a tall one, and
              stretching it opened a ~250px void inside its own card.

              When risk is LOCKED it collapses to a single line, and pairing a
              one-line module with the full decision panel left that void beside
              the decision instead. In that state the two stack, so the decision
              uses the width and nothing is held open.
            */}
            <div
              id="section-decision"
              className={
                riskLocked
                  ? 'order-1 flex scroll-mt-24 flex-col gap-5 lg:order-none'
                  : 'order-1 grid scroll-mt-24 grid-cols-1 items-start gap-5 lg:order-none lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]'
              }
            >
              <DecisionPanel feed={signals} detail={detail} />
              <RiskAssessmentModule policy={riskPolicy} account={paperAccount} detail={detail} />
            </div>

            {/* Signal -> Risk -> ACTION. Its own full-width region, so the step
                from intelligence to a recorded action is visible as a step
                rather than buried at the bottom of the decision panel. */}
            <div
              id="section-action"
              className="order-3 flex min-w-0 scroll-mt-24 flex-col lg:order-none [&>*]:flex-1"
            >
              <PaperActionPanel
                signalId={signalId}
                signedIn={signedIn}
                actionable={detail?.signal.status === 'accepted'}
                direction={
                  detail?.signal.direction === 'call' || detail?.signal.direction === 'put'
                    ? detail.signal.direction
                    : null
                }
                instrument={detail?.signal.asset ?? null}
                timeframe={detail?.signal.timeframe ?? null}
                expirySeconds={detail?.signal.expiration.seconds ?? null}
                capacity={capacity}
                model={activeModel}
                actionability={actionability?.ok ? actionability.data.decision : null}
                position={signalPosition}
              />
            </div>
          </div>

          {/* ================================================== right rail == */}
          <aside
            id="section-rail"
            aria-label="Account state"
            className="flex min-w-0 flex-col gap-5"
          >
            <AccountOverviewModule
              account={paperAccount}
              policy={riskPolicy}
              simulation={simulated}
            />
            <ActivePositionModule feed={positions} model={activeModel} />
            <RecentPositionsModule feed={positions} simulation={simulated} />
            <SystemStatusModule status={status} />
          </aside>
        </div>

        {/* Full width below the fold: the analysis matrix and the signal record
            are wide tables, and the simulation module is tall. None of them
            gains anything from being squeezed beside the rail. */}
        <div id="section-analysis" className="scroll-mt-24">
          <AnalysisMatrix detail={detail} />
        </div>

        <div
          id="section-signals"
          className="grid scroll-mt-24 grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]"
        >
          <SignalIntelligence feed={signals} positions={positions} />
          <PaperSimulationModule feed={simulated} catalogue={simulationModels} />
        </div>

        {/* Account accounting, below the live workspace. Separate from observed
            outcomes because one is what this user did and the other is what the
            analysis achieved. */}
        <section
          aria-labelledby="paper-heading-section"
          className="flex scroll-mt-24 flex-col gap-3 pt-1"
        >
          <h2 id="paper-heading-section" className="eyebrow px-1">
            Paper account
          </h2>
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <PaperAccountModule feed={paperAccount} />
            <AccountRiskModule policy={riskPolicy} account={paperAccount} events={riskEvents} />
            <div id="section-ledger" className="scroll-mt-24">
              <LedgerSummaryModule account={paperAccount} />
            </div>
          </div>
        </section>

        {/* Observed outcomes: measured accuracy over signals, with no payout
            applied. Kept apart from the account section above. */}
        <section
          aria-labelledby="analytics-heading"
          className="flex scroll-mt-24 flex-col gap-3 pt-1"
        >
          <h2 id="analytics-heading" className="eyebrow px-1">
            Observed outcomes
          </h2>
          <div className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <PerformanceModule analytics={analytics} calibration={calibration} />
            <ObservedBreakdown
              label="Strategy"
              feed={strategyAnalytics}
              emptyDetail="Per-strategy accuracy appears once signals from a strategy have settled."
            />
            <div className="flex sm:col-span-2 lg:col-span-1 [&>*]:flex-1">
              <ObservedBreakdown
                label="Regime"
                feed={regimeAnalytics}
                emptyDetail="Per-regime accuracy appears once signals decided in a regime have settled."
              />
            </div>
          </div>
          <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <CalibrationModule feed={calibrationReport} />
            <StrategyRegistryModule strategies={strategies} activeId={detail?.signal.strategy.id} />
          </div>
        </section>

        {/* Infrastructure, deliberately last and full width. */}
        <section aria-labelledby="system-heading" className="flex scroll-mt-24 flex-col gap-3 pt-1">
          <h2 id="system-heading" className="eyebrow px-1">
            System
          </h2>
          <SystemHealthStrip status={status} />
        </section>

        {/* Simulation, under its own heading. A backtest is not an observed
            outcome and must never sit in a grid that implies it is. */}
        <section
          aria-labelledby="simulation-heading"
          className="flex scroll-mt-24 flex-col gap-3 pt-1"
        >
          <h2 id="simulation-heading" className="eyebrow px-1">
            Historical simulation
          </h2>
          {/* A single module needs no grid. The two-column wrapper it used
              to sit in left half the row empty at every width above xl. */}
          <BacktestingModule feed={backtests} />
        </section>
      </div>
    </>
  );
}
