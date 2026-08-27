import type { CandleSeries } from '@binaryai/types';
import { IconExpand, IconIndicator, IconLayers } from '@/components/ui/icons';
import { Absent, Label } from '@/components/ui/primitives';
import { CandleChart } from './CandleChart';
import { TimeframeControl } from './TimeframeControl';

/**
 * The primary market canvas.
 *
 * Renders real candles when BinaryAI has them and a dormant terminal when it
 * does not. The container's partitioning — toolbar, plot area, OHLC rail, axis
 * gutters — is identical in both states, so activating a data source changes
 * the content and not the layout.
 *
 * What is drawn comes from stored, validated candles. What is never drawn: a
 * synthesised series, an interpolated gap, or a bar the quality scan rejected.
 */

function ToolbarButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled
      title={`${label} — available in a later phase`}
      aria-label={`${label} — available in a later phase`}
      className="flex h-7 items-center gap-1.5 rounded-md border border-edge px-2 text-[12px] text-text-3 transition-colors hover:border-edge-strong disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

/** Unlabelled tick gutter, used only in the dormant state. */
function EmptyPriceAxis() {
  return (
    <div
      aria-hidden
      className="hidden w-14 shrink-0 flex-col justify-between border-l border-edge py-3 sm:flex"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex items-center gap-1.5 pl-1.5">
          <span className="h-px w-1.5 bg-edge-strong" />
          <span className="text-[11px] text-text-3/50">—</span>
        </div>
      ))}
    </div>
  );
}

function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

export function MarketCanvas({
  series,
  reason,
  instrument,
}: {
  series: CandleSeries | null;
  reason?: string | undefined;
  instrument?: string | undefined;
}) {
  const candles = series?.candles ?? [];
  const hasData = candles.length > 0;
  const latest = candles.at(-1) ?? null;
  const volume = candles.reduce((total, candle) => total + (candle.volume ?? 0), 0);

  return (
    <section
      aria-labelledby="market-canvas-heading"
      className="flex flex-1 flex-col overflow-hidden rounded-[10px] border border-edge bg-surface-1"
    >
      {/* Chart toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-2.5">
        <h2 id="market-canvas-heading" className="eyebrow">
          {instrument ?? 'Market'}
        </h2>
        <div className="max-w-full min-w-0 overflow-x-auto">
          <TimeframeControl />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <ToolbarButton label="Indicators">
            <IconIndicator size={14} />
            <span className="hidden sm:inline">Indicators</span>
          </ToolbarButton>
          <ToolbarButton label="Overlays">
            <IconLayers size={14} />
            <span className="hidden sm:inline">Overlays</span>
          </ToolbarButton>
          <ToolbarButton label="Fullscreen">
            <IconExpand size={14} />
          </ToolbarButton>
        </div>
      </div>

      <div className="flex min-h-[360px] flex-1 lg:min-h-[440px]">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {hasData ? (
            <CandleChart candles={candles} timeframe={series?.timeframe ?? '1m'} />
          ) : (
            <>
              <div aria-hidden className="chart-grid absolute inset-0" />
              <div
                aria-hidden
                className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,var(--surface-1)_100%)]"
              />
              <div className="relative flex flex-1">
                <div className="relative flex flex-1 flex-col items-center justify-center gap-5 px-6 py-10 text-center">
                  <span className="eyebrow">Market Intelligence</span>
                  <p className="text-[26px] leading-none font-semibold tracking-tight text-text-2 sm:text-[32px]">
                    NO MARKET DATA
                  </p>
                  <p className="max-w-sm text-[13px] leading-relaxed text-text-3">
                    {reason ??
                      'BinaryAI is ready to analyse validated market data. No candles are stored for this instrument and timeframe.'}
                  </p>
                  <ul className="flex max-w-lg flex-wrap items-center justify-center gap-x-2 gap-y-1.5 pt-2">
                    {[
                      'Price action',
                      'Volume',
                      'Indicators',
                      'Signal markers',
                      'Market regime',
                      'AI annotations',
                    ].map((capability) => (
                      <li
                        key={capability}
                        className="rounded border border-edge px-2 py-1 text-[11px] tracking-wide text-text-3/80 uppercase"
                      >
                        {capability}
                      </li>
                    ))}
                  </ul>
                </div>
                <EmptyPriceAxis />
              </div>
              <div
                aria-hidden
                className="flex items-center justify-between border-t border-edge px-4 py-2"
              >
                {Array.from({ length: 7 }, (_, index) => (
                  <span key={index} className="text-[11px] text-text-3/50">
                    —
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        {/* OHLC metadata rail — real values once candles exist. */}
        <div className="hidden w-40 shrink-0 flex-col gap-5 border-l border-edge bg-surface-1/60 px-4 py-4 xl:flex">
          <div className="flex flex-col gap-3">
            <Label>Quote</Label>
            {(
              [
                ['Open', latest?.open],
                ['High', latest?.high],
                ['Low', latest?.low],
                ['Close', latest?.close],
              ] as const
            ).map(([field, value]) => (
              <div key={field} className="flex items-baseline justify-between gap-3">
                <span className="text-[12px] text-text-3">{field}</span>
                <span className="tnum text-[13px]">
                  {value === undefined || value === null ? <Absent /> : formatPrice(value)}
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-3 border-t border-edge pt-4">
            <Label>Session</Label>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] text-text-3">Volume</span>
              <span className="tnum text-[13px]">{hasData ? volume.toFixed(2) : <Absent />}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] text-text-3">Bars</span>
              <span className="tnum text-[13px]">{hasData ? candles.length : <Absent />}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] text-text-3">Source</span>
              <span className="tnum text-[11px] text-text-2">
                {series ? series.source.replace(/_/g, ' ') : <Absent />}
              </span>
            </div>
          </div>

          <div className="mt-auto flex flex-col gap-2 border-t border-edge pt-4">
            <Label>AI overlay</Label>
            <p className="text-[11px] leading-relaxed text-text-3">
              Signal, confidence and regime markers render here once a decision exists.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
