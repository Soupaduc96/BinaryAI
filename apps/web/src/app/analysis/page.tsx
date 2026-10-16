import { AnalysisMatrix } from '@/components/workspace/AnalysisMatrix';
import { InstrumentContext } from '@/components/workspace/InstrumentContext';
import { InstrumentPicker } from '@/components/workspace/InstrumentPicker';
import { MarketCanvas } from '@/components/workspace/MarketCanvas';
import { MarketContextStrip } from '@/components/workspace/MarketContextStrip';
import { WorkspaceHeader } from '@/components/shell/WorkspaceHeader';
import { fetchAssetClasses } from '@/lib/api-instruments';
import {
  loadDecision,
  loadMarket,
  resolveOverlays,
  resolveWorkspace,
  type SearchParams,
} from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * Market Analysis.
 *
 * This workspace OWNS instrument and timeframe selection. Both live in the URL,
 * so a view is shareable and survives a refresh, and every other workspace
 * reads them rather than re-deriving them.
 *
 * The page is arranged as an answer to two questions in order:
 *
 *   1. WHAT AM I LOOKING AT?  the picker, then the capability panel
 *   2. WHAT IS IT DOING?      the chart, then the measured readings
 *
 * The capability panel sits above the chart deliberately. A chart for an
 * instrument the engine does not analyse looks identical to one it does, and
 * the honest ordering is to say which this is before drawing it.
 */
export default async function AnalysisPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const context = await resolveWorkspace(params);
  const [market, decision, classes] = await Promise.all([
    loadMarket(context),
    loadDecision(context),
    fetchAssetClasses(),
  ]);
  const overlays = resolveOverlays(params, context, market.series, decision.signals);

  const catalogue = context.catalogue.ok ? context.catalogue.data : null;
  const assetClasses = catalogue?.assetClasses ?? [];
  const selected = context.selected;

  // The provider serving THIS instrument's class — not the primary one. On a
  // multi-asset deployment those differ, and naming the wrong one would
  // misattribute the data the user is looking at.
  const providerId = selected
    ? (assetClasses.find((entry) => entry.assetClass === selected.instrument.assetClass)
        ?.providerId ?? null)
    : null;
  const provider =
    providerId && classes.ok
      ? (classes.data.providers.find((entry) => entry.id === providerId) ?? null)
      : null;

  return (
    <>
      <MarketContextStrip
        marketData={market.marketData}
        timeframe={context.timeframe}
        instrument={selected?.instrument.displaySymbol ?? context.instrument}
        series={market.series}
        provider={provider}
        marketState={selected?.marketState ?? null}
      />

      <div className="flex flex-col gap-5 px-4 py-5 lg:px-6 lg:py-6">
        <WorkspaceHeader
          eyebrow="Prensipal"
          title="Analiz mache"
          lede="Enstriman ak entèval ou chwazi isit la kondi tout lòt espas travay yo. Endikatè yo kalkile depi bouji ki anrejistre yo, ak menm fonksyon motè a itilize."
        />

        {/*
          The picker sits on its own line rather than inside a panel: it is a
          control, and boxing a single control in a card is the generic-SaaS
          habit this interface avoids. The capability panel below carries the
          border, because it is genuinely a region of information.
        */}
        <div className="flex flex-wrap items-end gap-3">
          <InstrumentPicker
            instruments={catalogue?.instruments ?? []}
            assetClasses={assetClasses}
            current={selected}
            timeframe={context.timeframe}
          />
          {context.catalogue.ok ? null : (
            <p className="text-[11.5px] text-bear">
              The instrument catalogue could not be loaded. {context.catalogue.error}
            </p>
          )}
        </div>

        {selected ? (
          <InstrumentContext
            entry={selected}
            provider={provider}
            assetClassLabel={
              assetClasses.find((entry) => entry.assetClass === selected.instrument.assetClass)
                ?.label ?? selected.instrument.assetClass
            }
          />
        ) : null}

        <MarketCanvas
          series={market.series}
          reason={market.reason}
          instrument={selected?.instrument.displaySymbol ?? context.instrument ?? undefined}
          // The timeframes THIS instrument's provider serves, not the primary
          // provider's. Coinbase and the equity vendor need not agree.
          supportedTimeframes={selected?.instrument.supportedTimeframes ?? undefined}
          indicatorLines={overlays.indicatorLines}
          markers={overlays.markers}
          showLastPrice={overlays.showLastPrice}
        />

        <AnalysisMatrix detail={decision.detail} />
      </div>
    </>
  );
}
