import type { CandleSeries, InstrumentStatus, PersistedSignal, Timeframe } from '@binaryai/types';
import { readTimeframe } from '@/lib/timeframe';
import { computeIndicatorLines, readIndicators, readOverlays } from '@/lib/chart-overlays';
import type { SignalMarker } from '@/components/workspace/CandleChart';
import {
  fetchAuthContext,
  fetchPaperAccount,
  fetchPositions,
  fetchRiskPolicy,
  fetchSimulation,
  fetchAssets,
  fetchCandles,
  fetchMarketDataStatus,
  fetchSignalDetail,
  fetchSignals,
  type ApiResult,
  type AssetFeed,
  type MarketDataFeed,
  type SignalFeed,
} from '@/lib/api';
import { fetchInstruments, type InstrumentFeed } from '@/lib/api-instruments';

/**
 * Shared workspace resolution.
 *
 * The instrument and timeframe are read by several routes now, and before this
 * module existed the derivation was duplicated in `layout.tsx` and `page.tsx` —
 * where the two had already drifted: the layout took the first stored asset and
 * ignored `?asset=` entirely, so the command bar could name a different
 * instrument from the one the chart was drawing.
 *
 * Every fetcher below is request-cached, so a route calling two of these pays
 * for each endpoint once no matter how many callers ask.
 */

export type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface WorkspaceContext {
  /** The instrument in view as a canonical symbol, or null when none resolves. */
  readonly instrument: string | null;
  /** The full catalogue entry for it, with availability. Null when unresolved. */
  readonly selected: InstrumentStatus | null;
  readonly timeframe: Timeframe;
  /** Instruments BinaryAI actually holds candles for — never the provider's catalogue. */
  readonly storedAssets: readonly { symbol: string; displayName: string }[];
  readonly assets: ApiResult<AssetFeed>;
  /** The server-defined catalogue with per-instrument availability. */
  readonly catalogue: ApiResult<InstrumentFeed>;
}

/**
 * THE ONE AUTHORITATIVE INSTRUMENT RESOLUTION.
 *
 * Every route calls this and nothing derives an instrument any other way. That
 * is the fix for a specific, embarrassing class of bug: before Phase 9 the
 * layout resolved the instrument from the stored-asset list while the page
 * resolved it from `?asset=`, so the command bar and the chart could name
 * different instruments on the same screen.
 *
 * Resolution order, and why:
 *
 *  1. `?asset=` when it names a CATALOGUE instrument. The catalogue is the
 *     authority, not the stored list — asking for an instrument BinaryAI knows
 *     but has not ingested is a legitimate request that should show the
 *     instrument with an empty chart, not silently substitute another one.
 *  2. The first stored instrument, so a fresh workspace opens on something real.
 *  3. The first catalogue entry, so the picker has a subject even on an empty
 *     database.
 *
 * A symbol that resolves to nothing yields `null` rather than a fallback, and
 * the UI says so. Silently swapping in a different instrument is how a user
 * ends up reading BTC while believing they are looking at gold.
 */
export async function resolveWorkspace(params: SearchParams): Promise<WorkspaceContext> {
  // The timeframe is resolved FIRST because availability depends on it: the
  // catalogue answers "is there a chart" for this timeframe, not in general.
  const timeframe = readTimeframe(params['tf']);
  const [assets, catalogue] = await Promise.all([fetchAssets(), fetchInstruments(timeframe)]);

  const storedAssets = assets.ok
    ? assets.data.assets.map((asset) => ({
        symbol: asset.symbol,
        // The display symbol when the catalogue knows one, so `BTC-USD` renders
        // as BTC/USD without the stored string being reinterpreted.
        displayName: asset.displaySymbol ?? asset.displayName ?? asset.symbol,
      }))
    : [];

  const entries = catalogue.ok ? catalogue.data.instruments : [];
  const bySymbol = new Map(entries.map((entry) => [entry.instrument.symbol, entry]));

  const requested = first(params['asset']);
  const selected =
    (requested === undefined ? undefined : bySymbol.get(requested)) ??
    (storedAssets[0] === undefined ? undefined : bySymbol.get(storedAssets[0].symbol)) ??
    entries[0] ??
    null;

  return {
    instrument: selected?.instrument.symbol ?? storedAssets[0]?.symbol ?? null,
    selected,
    timeframe,
    storedAssets,
    assets,
    catalogue,
  };
}

export interface MarketView {
  readonly marketData: ApiResult<MarketDataFeed>;
  readonly series: CandleSeries | null;
  readonly reason: string | undefined;
}

/** Candles for the resolved instrument, with the API's own reason when empty. */
export async function loadMarket(context: WorkspaceContext): Promise<MarketView> {
  const marketData = await fetchMarketDataStatus();

  if (!context.instrument) {
    return {
      marketData,
      series: null,
      reason: context.assets.ok
        ? context.assets.data.reason
        : 'The dashboard cannot reach the API to list instruments.',
    };
  }

  const candles = await fetchCandles(context.instrument, context.timeframe);
  if (!candles.ok) return { marketData, series: null, reason: candles.error };
  return { marketData, series: candles.data.series, reason: candles.data.reason };
}

export interface DecisionView {
  readonly signals: ApiResult<SignalFeed>;
  readonly detail: PersistedSignal | null;
  /**
   * The PERSISTED identifier, taken from the list row.
   *
   * Never `detail.signal.id`: that is the engine's own `sig_<uuid>` snapshot id,
   * which no position or action endpoint can resolve.
   */
  readonly signalId: string | null;
}

/**
 * The most recent signal FOR ONE INSTRUMENT, and its full reasoning.
 *
 * D2. This took no argument and read the newest signal across every
 * instrument, so the Overview could show a BTC decision beside a EUR/USD chart.
 * With one analysed instrument that was invisible; with two it is guaranteed.
 *
 * The context is required rather than optional. An optional scope would leave
 * the old behaviour reachable by omission, and the failure it produces —
 * a decision attributed to the wrong instrument — is exactly the kind that
 * looks plausible on screen.
 *
 * A workspace with no resolved instrument gets an empty decision rather than
 * someone else's: there is no instrument to have an opinion about.
 */
export async function loadDecision(context: WorkspaceContext): Promise<DecisionView> {
  if (!context.instrument) {
    return { signals: { ok: true, data: { signals: [], total: 0 } }, detail: null, signalId: null };
  }

  const signals = await fetchSignals(context.instrument);
  const latest = signals.ok ? signals.data.signals[0] : undefined;
  if (!latest) return { signals, detail: null, signalId: null };

  const result = await fetchSignalDetail(latest.id);
  return { signals, detail: result.ok ? result.data : null, signalId: latest.id };
}

export interface ChartOverlays {
  readonly indicatorLines: ReturnType<typeof computeIndicatorLines>;
  readonly markers: readonly SignalMarker[];
  readonly showLastPrice: boolean;
  readonly selectedIndicators: readonly string[];
  readonly selectedOverlays: readonly string[];
}

/**
 * Overlay selection from the URL, computed against the candles already loaded.
 *
 * Markers are filtered to THIS instrument and timeframe: a decision recorded on
 * another series is not a mark on this one, and drawing it would place a
 * decision on a bar it was never made against.
 */
export function resolveOverlays(
  params: SearchParams,
  context: WorkspaceContext,
  series: CandleSeries | null,
  signals: ApiResult<SignalFeed>,
): ChartOverlays {
  const selectedIndicators = readIndicators(params['ind']);
  const selectedOverlays = readOverlays(params['ov']);

  const markers =
    selectedOverlays.includes('signals') && signals.ok
      ? signals.data.signals
          .filter(
            (signal) =>
              signal.timeframe === context.timeframe &&
              (context.instrument === null || signal.assetSymbol === context.instrument) &&
              (signal.direction === 'call' || signal.direction === 'put'),
          )
          .map((signal) => ({
            at: signal.decidedAt,
            direction: signal.direction as 'call' | 'put',
            status: signal.status,
          }))
      : [];

  return {
    indicatorLines: computeIndicatorLines(series?.candles ?? [], selectedIndicators),
    markers,
    showLastPrice: selectedOverlays.includes('last'),
    selectedIndicators,
    selectedOverlays,
  };
}

// ------------------------------------------------------------ paper account --

export interface PaperContext {
  readonly signedIn: boolean;
  readonly paperAccount: Awaited<ReturnType<typeof fetchPaperAccount>>;
  readonly riskPolicy: Awaited<ReturnType<typeof fetchRiskPolicy>>;
  readonly positions: Awaited<ReturnType<typeof fetchPositions>>;
  readonly simulated: Awaited<ReturnType<typeof fetchSimulation>>;
  /** Null until both the account and its policy are readable. */
  readonly capacity: {
    readonly availableUnits: number;
    readonly committedUnits: number;
    readonly openPositions: number;
    readonly maxOpenPositions: number;
    readonly maxPositionSize: number;
  } | null;
  readonly activeModel: ReturnType<typeof activeModelOf>;
  /** True when the policy is unreadable because nobody is signed in. */
  readonly riskLocked: boolean;
}

function activeModelOf(simulated: Awaited<ReturnType<typeof fetchSimulation>>) {
  return simulated.ok ? simulated.data.simulation.model : null;
}

/**
 * Account state shared by the Overview, Paper Trading and Ledger workspaces.
 *
 * Fetched together rather than in sequence, and request-cached, so three routes
 * asking for the same account cost one round trip each per request.
 */
export async function loadPaperContext(): Promise<PaperContext> {
  const [authContext, paperAccount, riskPolicy, positions, simulated] = await Promise.all([
    fetchAuthContext(),
    fetchPaperAccount(),
    fetchRiskPolicy(),
    fetchPositions(),
    fetchSimulation(),
  ]);

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

  return {
    signedIn: authContext.ok && authContext.data.authenticated,
    paperAccount,
    riskPolicy,
    positions,
    simulated,
    capacity,
    activeModel: activeModelOf(simulated),
    // A locked risk module is one line tall; layouts react to that rather than
    // pairing it with a full-height panel and leaving a void.
    riskLocked: !riskPolicy.ok && riskPolicy.unauthorized === true,
  };
}
