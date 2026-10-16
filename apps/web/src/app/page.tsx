import { ActivePositionModule } from '@/components/account/ActivePosition';
import { AnalysisScopeNotice } from '@/components/workspace/AnalysisScopeNotice';
import { DecisionPanel } from '@/components/workspace/DecisionPanel';
import { MarketCanvas } from '@/components/workspace/MarketCanvas';
import { MarketContextStrip } from '@/components/workspace/MarketContextStrip';
import { PaperActionPanel } from '@/components/workspace/PaperActionPanel';
import {
  AccountOverviewModule,
  RiskAssessmentModule,
  SystemStatusModule,
} from '@/components/workspace/RightRail';
import { WorkspaceHeader } from '@/components/shell/WorkspaceHeader';
import { fetchSystemStatus } from '@/lib/api';
import { fetchAssetClasses } from '@/lib/api-instruments';
import { fetchActionability } from '@/lib/api-risk';
import {
  loadDecision,
  loadMarket,
  loadPaperContext,
  resolveOverlays,
  resolveWorkspace,
  type SearchParams,
} from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * Overview — the command centre.
 *
 * The one question this page answers: **what is happening right now, and what
 * can I do about it.** Market, decision, whether an action is permitted, and
 * enough account and system state to know whether to trust either.
 *
 * It is deliberately NOT the whole product. Depth lives in the workspaces the
 * rail leads to — the signal record, the ledger, the analytics, the runtime.
 * Before the split every one of those was stacked here, which made the rail a
 * table of contents and this page four thousand pixels tall.
 *
 * The chart is here without its tooling. Indicators, overlays and the
 * instrument selector belong to Analysis, which owns that decision; repeating
 * them here would be two places to change the same thing.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const context = await resolveWorkspace(params);

  const [market, decision, paper, status, classes] = await Promise.all([
    loadMarket(context),
    loadDecision(context),
    loadPaperContext(),
    fetchSystemStatus(),
    fetchAssetClasses(),
  ]);

  const overlays = resolveOverlays(params, context, market.series, decision.signals);

  // The engine's instruments, canonical, straight from the catalogue endpoint —
  // the same set the availability resolver compares against, so the banner and
  // the capability panel can never disagree.
  const analysedSymbols = context.catalogue.ok ? context.catalogue.data.analysedSymbols : [];
  // The venue serving THIS instrument's class. Reading the primary provider
  // instead labelled every instrument with the crypto exchange's name.
  const selectedClass = context.selected?.instrument.assetClass ?? null;
  const providerId =
    selectedClass && context.catalogue.ok
      ? (context.catalogue.data.assetClasses.find((entry) => entry.assetClass === selectedClass)
          ?.providerId ?? null)
      : null;
  const instrumentProvider =
    providerId && classes.ok
      ? (classes.data.providers.find((entry) => entry.id === providerId) ?? null)
      : null;

  // Display forms for the analysed set, in the same order. Falls back to the
  // canonical symbol for anything the catalogue payload did not include.
  const analysedDisplays = analysedSymbols.map((symbol) => {
    const entry = context.catalogue.ok
      ? context.catalogue.data.instruments.find((row) => row.instrument.symbol === symbol)
      : undefined;
    return entry?.instrument.displaySymbol ?? symbol;
  });

  const signalPosition =
    decision.signalId && paper.positions.ok
      ? (paper.positions.data.positions.find((entry) => entry.signalId === decision.signalId) ??
        null)
      : null;

  const actionability =
    paper.signedIn &&
    decision.signalId &&
    decision.detail?.signal.status === 'accepted' &&
    !signalPosition
      ? await fetchActionability(decision.signalId)
      : null;

  return (
    <>
      <MarketContextStrip
        marketData={market.marketData}
        timeframe={context.timeframe}
        instrument={context.selected?.instrument.displaySymbol ?? context.instrument}
        series={market.series}
        provider={instrumentProvider}
        marketState={context.selected?.marketState ?? null}
      />

      <div className="flex flex-col gap-5 px-4 py-5 lg:px-6 lg:py-6">
        {/* Before anything else: whether the decision below refers to the
            chart below. See AnalysisScopeNotice — it renders nothing when the
            viewed instrument IS the analysed one. */}
        <AnalysisScopeNotice
          viewing={context.selected}
          analysedSymbols={analysedSymbols}
          analysedDisplays={analysedDisplays}
        />

        <WorkspaceHeader
          eyebrow="Prensipal"
          title="Sant kòmandman"
          lede="Mache a kounye a, vèdik aktyèl motè a, epi si yon aksyon pèmèt sou li. Sipò desizyon sèlman — BinaryAI pa pase okenn lòd epi li pa konekte ak okenn courtier."
        />

        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px] 2xl:grid-cols-[minmax(0,1fr)_420px]">
          {/* ============================================== main workspace == */}
          <div className="flex min-w-0 flex-col gap-5">
            {/* order-2 below lg: on a phone the decision leads, because that is
                what the app is opened to read. The chart follows it. */}
            <div className="order-2 flex min-w-0 flex-col lg:order-none">
              <MarketCanvas
                series={market.series}
                reason={market.reason}
                instrument={
                  context.selected?.instrument.displaySymbol ?? context.instrument ?? undefined
                }
                // This instrument's provider, not the primary one: on a
                // multi-asset deployment the two need not serve the same set.
                supportedTimeframes={context.selected?.instrument.supportedTimeframes ?? undefined}
                indicatorLines={overlays.indicatorLines}
                markers={overlays.markers}
                showLastPrice={overlays.showLastPrice}
              />
            </div>

            {/*
              items-start: risk is a short module beside a tall one, and
              stretching it opened a void inside its own card. When risk is
              LOCKED it collapses to a single line, so the two stack instead.
            */}
            <div
              className={
                paper.riskLocked
                  ? 'order-1 flex flex-col gap-5 lg:order-none'
                  : 'order-1 grid grid-cols-1 items-start gap-5 lg:order-none lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]'
              }
            >
              <DecisionPanel feed={decision.signals} detail={decision.detail} />
              <RiskAssessmentModule
                policy={paper.riskPolicy}
                account={paper.paperAccount}
                detail={decision.detail}
              />
            </div>

            <div className="order-3 flex min-w-0 flex-col lg:order-none [&>*]:flex-1">
              <PaperActionPanel
                signalId={decision.signalId}
                signedIn={paper.signedIn}
                actionable={decision.detail?.signal.status === 'accepted'}
                direction={
                  decision.detail?.signal.direction === 'call' ||
                  decision.detail?.signal.direction === 'put'
                    ? decision.detail.signal.direction
                    : null
                }
                instrument={decision.detail?.signal.asset ?? null}
                timeframe={decision.detail?.signal.timeframe ?? null}
                expirySeconds={decision.detail?.signal.expiration.seconds ?? null}
                capacity={paper.capacity}
                model={paper.activeModel}
                actionability={actionability?.ok ? actionability.data.decision : null}
                position={signalPosition}
              />
            </div>
          </div>

          {/* ======================================================= rail == */}
          <aside aria-label="Account state" className="flex min-w-0 flex-col gap-5">
            <AccountOverviewModule
              account={paper.paperAccount}
              policy={paper.riskPolicy}
              simulation={paper.simulated}
            />
            <ActivePositionModule feed={paper.positions} model={paper.activeModel} />
            <SystemStatusModule status={status} />
          </aside>
        </div>
      </div>
    </>
  );
}
