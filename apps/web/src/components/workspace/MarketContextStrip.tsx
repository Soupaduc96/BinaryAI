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
}: {
  marketData: ApiResult<MarketDataFeed>;
  timeframe: Timeframe;
  instrument: string | null;
  series: CandleSeries | null;
}) {
  const status = marketData.ok ? marketData.data.status : null;
  const state = status
    ? STATE_LABEL[status.state]
    : { label: 'UNKNOWN', health: 'unavailable' as HealthKind };

  const provider = marketData.ok ? marketData.data.provider : null;
  const lastCandleAt = series?.candles.at(-1)?.timestamp ?? status?.lastCandleAt ?? null;
  const ageSeconds =
    lastCandleAt === null ? null : Math.max(Math.round((Date.now() - lastCandleAt) / 1000), 0);

  // Server-rendered on a force-dynamic page: this is request time.
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  return (
    <section
      aria-label="Market context"
      className="grid grid-cols-2 divide-edge/60 border-b border-edge bg-surface-1/35 sm:grid-cols-3 sm:divide-x lg:grid-cols-6"
    >
      <Cell label="Instrument" className="border-b border-edge/60 sm:border-b-0">
        {instrument ? (
          <span className="truncate whitespace-nowrap">{instrument}</span>
        ) : (
          // No stored instrument means none to name. A placeholder symbol here
          // would be the first fabricated data point on the page.
          <span className="truncate whitespace-nowrap text-text-3">NO INSTRUMENT</span>
        )}
      </Cell>

      <Cell label="Timeframe" className="border-b border-edge sm:border-b-0">
        <TimeframeReadout timeframe={timeframe} />
      </Cell>

      <Cell label="Market" className="border-b border-edge/60 lg:border-b-0">
        <StatusDot health={state.health} />
        <span className="tnum">{state.label}</span>
      </Cell>

      <Cell label="Data source" className="border-b border-edge lg:border-b-0">
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

      <Cell label="Last update">
        {lastCandleAt === null ? (
          <Absent />
        ) : (
          <span className="tnum text-[13px]" title={new Date(lastCandleAt).toISOString()}>
            {formatAge(ageSeconds)}
          </span>
        )}
      </Cell>

      <Cell label="Session">
        <span className="tnum text-[13px] text-text-2">{now}Z</span>
      </Cell>
    </section>
  );
}
