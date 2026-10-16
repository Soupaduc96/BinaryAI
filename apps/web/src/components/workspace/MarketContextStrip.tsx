import type { CandleSeries, MarketDataStatus, Timeframe } from '@binaryai/types';
import type { ApiResult, MarketDataFeed } from '@/lib/api';
import { Absent, StatusDot, type HealthKind } from '@/components/ui/primitives';
import { TimeframeReadout } from './TimeframeControl';

/**
 * Market context strip.
 *
 * Answers "what am I looking at, and can I trust it?" before anything else.
 * Every value is derived from the API's real market-data status — the strip
 * cannot report LIVE while no provider is connected, and it distinguishes STALE
 * from CONNECTED so old prices are never presented as current.
 */

const STATE_LABEL: Record<MarketDataStatus['state'], { label: string; health: HealthKind }> = {
  not_configured: { label: 'WAITING', health: 'not_configured' },
  connected: { label: 'LIVE', health: 'ok' },
  degraded: { label: 'NO DATA', health: 'degraded' },
  disconnected: { label: 'DISCONNECTED', health: 'unavailable' },
  stale: { label: 'STALE', health: 'degraded' },
};

/**
 * One reading in the strip.
 *
 * The value is deliberately much louder than its label: this row is telemetry,
 * and an operator scans the numbers, not the words describing them. The label
 * is small, wide-tracked and dim; the value is large and primary.
 */
function Cell({
  label,
  children,
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-2 px-5 py-3 ${className}`}>
      <span className="telemetry-label">{label}</span>
      <div className="flex items-center gap-2 text-[15px] leading-none font-medium tracking-[-0.01em] text-text-1">
        {children}
      </div>
    </div>
  );
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function MarketContextStrip({
  marketData,
  timeframe,
  instrument,
  series,
  provider: instrumentProvider,
  marketState,
  stalenessThresholdSeconds = 300,
}: {
  marketData: ApiResult<MarketDataFeed>;
  timeframe: Timeframe;
  instrument: string | null;
  series: CandleSeries | null;
  /**
   * The provider serving THIS instrument's asset class.
   *
   * Passed in rather than read from the market-data status, which reports the
   * PRIMARY provider only. On a multi-asset deployment those differ, and the
   * strip cheerfully labelled AAPL as sourced from `COINBASE EXCHANGE` —
   * naming the wrong venue for the price on screen.
   *
   * Undefined falls back to the primary, which is correct on a single-provider
   * deployment and is what every caller without an instrument in hand needs.
   */
  provider?: { displayName: string; dataOrigin: string } | null;
  /**
   * How fresh THIS instrument's newest stored candle is, in seconds.
   *
   * D6. The MARKET cell used to render a single global connection state derived
   * from the newest candle across every instrument — dominated by whichever one
   * the worker polls. AAPL therefore showed `MARKET LIVE` beside
   * `LAST UPDATE 23h ago`: two cells of the same strip contradicting each other.
   * Undefined falls back to the global state, which is correct only when no
   * instrument is in view.
   */
  /**
   * The API's per-instrument, per-timeframe verdict, when the caller has one.
   *
   * R7. Preferred over deriving freshness here, so the strip and the capability
   * panel cannot disagree about the same instrument. Falls back to the local
   * derivation when absent — which is correct for a caller with no timeframe.
   */
  marketState?: { state: string; ageSeconds: number | null } | null;
  stalenessThresholdSeconds?: number;
}) {
  const status = marketData.ok ? marketData.data.status : null;
  const lastCandleAt = series?.candles.at(-1)?.timestamp ?? null;
  const ageSeconds =
    lastCandleAt === null ? null : Math.max(Math.round((Date.now() - lastCandleAt) / 1000), 0);

  /*
   * The MARKET cell now describes THIS INSTRUMENT.
   *
   * Derived from the candles actually on screen rather than from the global
   * status, so the cell cannot claim LIVE for an instrument whose newest bar is
   * a day old. The provider-level state is still consulted for the cases only
   * it can answer — nothing configured, or the provider unreachable — because
   * those are true regardless of which instrument is selected.
   */
  const state = ((): { label: string; health: HealthKind } => {
    if (!status) return { label: 'UNKNOWN', health: 'unavailable' };
    // Provider-level facts outrank per-instrument freshness: there is no such
    // thing as fresh data from a provider that is not configured.
    if (status.state === 'not_configured' || status.state === 'disconnected') {
      return STATE_LABEL[status.state];
    }
    if (instrument === null) return STATE_LABEL[status.state];

    // The API's verdict wins when supplied: one source, one answer, and the
    // strip cannot contradict the capability panel beside it.
    if (marketState) {
      if (marketState.state === 'live') return { label: 'LIVE', health: 'ok' };
      if (marketState.state === 'stale') return { label: 'STALE', health: 'degraded' };
      if (marketState.state === 'no_data') return { label: 'NO DATA', health: 'degraded' };
      return { label: 'WAITING', health: 'not_configured' };
    }

    if (ageSeconds === null) return { label: 'NO DATA', health: 'degraded' };
    return ageSeconds > stalenessThresholdSeconds
      ? { label: 'STALE', health: 'degraded' }
      : { label: 'LIVE', health: 'ok' };
  })();

  const provider =
    instrumentProvider !== undefined
      ? instrumentProvider
      : marketData.ok
        ? marketData.data.provider
        : null;
  // Server-rendered on a force-dynamic page: this is request time.
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  return (
    <section
      aria-label="Kontèks mache"
      className="grid grid-cols-2 divide-edge/60 border-b border-edge bg-surface-1/35 sm:grid-cols-3 sm:divide-x lg:grid-cols-6"
    >
      <Cell label="Enstriman" className="border-b border-edge/60 sm:border-b-0">
        {instrument ? (
          <span className="truncate whitespace-nowrap">{instrument}</span>
        ) : (
          // No stored instrument means none to name. A placeholder symbol here
          // would be the first fabricated data point on the page.
          <span className="truncate whitespace-nowrap text-text-3">NO INSTRUMENT</span>
        )}
      </Cell>

      <Cell label="Entèval" className="border-b border-edge sm:border-b-0">
        <TimeframeReadout timeframe={timeframe} />
      </Cell>

      <Cell label="Mache" className="border-b border-edge/60 lg:border-b-0">
        <StatusDot health={state.health} />
        <span className="tnum">{state.label}</span>
      </Cell>

      <Cell label="Sous done" className="border-b border-edge lg:border-b-0">
        {provider ? (
          <span
            className="tnum truncate text-[13px]"
            title={`${provider.displayName} · ${provider.dataOrigin} data`}
          >
            {provider.displayName.toUpperCase()}
          </span>
        ) : (
          <span className="tnum text-text-3">NOT CONNECTED</span>
        )}
      </Cell>

      <Cell label="Dènye mizajou">
        {lastCandleAt === null ? (
          <Absent />
        ) : (
          <span className="tnum text-[13px]" title={new Date(lastCandleAt).toISOString()}>
            {formatAge(ageSeconds)}
          </span>
        )}
      </Cell>

      <Cell label="Sesyon">
        <span className="tnum text-[13px] text-text-2">{now}Z</span>
      </Cell>
    </section>
  );
}
