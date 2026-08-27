import type { Candle } from '@binaryai/types';

/**
 * Candlestick renderer.
 *
 * Inline SVG rather than a charting library, and that was a considered choice
 * rather than a shortcut. The requirement here is: draw N candles, a price
 * scale and a time axis, in the terminal's existing visual language. Every
 * candidate library (lightweight-charts, uPlot, Recharts) brings its own canvas
 * lifecycle, theming layer and client-side runtime to do that, and would have
 * to be restyled to match the design that is now frozen. This is ~120 lines,
 * ships no JavaScript to the browser, and renders on the server.
 *
 * It deliberately does NOT implement zoom, pan or a crosshair — those need a
 * client runtime and belong with a real charting library once interaction is
 * actually required. The container reserves space for them.
 *
 * Every value drawn comes from stored, validated candles. Nothing is
 * interpolated, smoothed or extended: a gap in the data is a gap on the chart.
 */

interface Scale {
  readonly min: number;
  readonly max: number;
}

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 420;
const PADDING_TOP = 14;
const PADDING_BOTTOM = 14;
/** Caps how wide one bar's slot may grow when few candles exist. */
const MAX_SLOT = 44;
const MAX_BODY = 20;

function priceScale(candles: readonly Candle[]): Scale {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const candle of candles) {
    if (candle.low < min) min = candle.low;
    if (candle.high > max) max = candle.high;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: min * 0.999, max: max * 1.001 };
  // A little headroom so wicks never touch the frame.
  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
}

function formatPrice(value: number): string {
  if (value >= 1000) return value.toFixed(0);
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(5);
}

function formatTime(epochMs: number, timeframe: string): string {
  const date = new Date(epochMs);
  const iso = date.toISOString();
  // Daily bars need the date; intraday bars need the clock.
  return timeframe === '1d' ? iso.slice(5, 10) : iso.slice(11, 16);
}

export function CandleChart({
  candles,
  timeframe,
}: {
  candles: readonly Candle[];
  timeframe: string;
}) {
  if (candles.length === 0) return null;

  const scale = priceScale(candles);
  const plotHeight = VIEW_HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  // Bounded so a short series is legible instead of scattered, and a long one
  // still fills the plot.
  const slot = Math.min(VIEW_WIDTH / candles.length, MAX_SLOT);
  const bodyWidth = Math.max(Math.min(slot * 0.6, MAX_BODY), 2);
  const plotWidth = slot * candles.length;
  // A series too short to fill the plot is CENTRED. Left-aligned, three bars
  // read as a chart that failed to load rather than as a feed that has only
  // just started; centred, the empty space reads as the scale it is drawn on.
  const offset = Math.max((VIEW_WIDTH - plotWidth) / 2, 0);

  const y = (price: number): number =>
    PADDING_TOP + ((scale.max - price) / (scale.max - scale.min)) * plotHeight;

  const gridLines = 5;
  const priceTicks = Array.from({ length: gridLines }, (_, index) => {
    const ratio = index / (gridLines - 1);
    return scale.max - ratio * (scale.max - scale.min);
  });

  const timeTickCount = Math.min(6, candles.length);
  const timeTicks = Array.from({ length: timeTickCount }, (_, index) => {
    const position = Math.floor((index / Math.max(timeTickCount - 1, 1)) * (candles.length - 1));
    return { candle: candles[position]!, x: position * slot + slot / 2 };
  });

  const first = candles[0]!;
  const last = candles.at(-1)!;
  const rising = last.close >= first.open;

  return (
    <figure className="flex min-w-0 flex-1 flex-col">
      <figcaption className="sr-only">
        {candles.length} {timeframe} candles from {new Date(first.timestamp).toISOString()} to{' '}
        {new Date(last.timestamp).toISOString()}. Latest close {formatPrice(last.close)}.
      </figcaption>

      <div className="flex min-h-0 flex-1">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-full min-h-[320px] w-full"
          role="img"
          aria-label={`Candlestick chart, ${candles.length} ${timeframe} bars, latest close ${formatPrice(last.close)}`}
        >
          {priceTicks.map((price, index) => (
            <line
              key={price}
              x1={0}
              x2={VIEW_WIDTH}
              y1={y(price)}
              y2={y(price)}
              stroke="var(--edge)"
              strokeWidth={1}
              // The outer rules frame the plot; the inner ones only hint at it.
              opacity={index === 0 || index === priceTicks.length - 1 ? 0.9 : 0.45}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* Vertical rules on the bars actually drawn. Never a fixed lattice:
              a rule with no bar behind it implies a period that has no data. */}
          {candles.map((candle, index) =>
            index % 4 === 0 ? (
              <line
                key={`v${candle.timestamp}`}
                x1={offset + index * slot + slot / 2}
                x2={offset + index * slot + slot / 2}
                y1={PADDING_TOP}
                y2={VIEW_HEIGHT - PADDING_BOTTOM}
                stroke="var(--edge)"
                strokeWidth={1}
                opacity={0.35}
                vectorEffect="non-scaling-stroke"
              />
            ) : null,
          )}

          {/* The last close, as a reference. A real value from a real bar. */}
          <line
            x1={offset}
            x2={offset + plotWidth}
            y1={y(last.close)}
            y2={y(last.close)}
            stroke="var(--accent)"
            strokeWidth={1}
            strokeDasharray="3 4"
            opacity={0.5}
            vectorEffect="non-scaling-stroke"
          />

          {candles.map((candle, index) => {
            const centre = offset + index * slot + slot / 2;
            const up = candle.close >= candle.open;
            const colour = up ? 'var(--bull)' : 'var(--bear)';
            const bodyTop = y(Math.max(candle.open, candle.close));
            const bodyBottom = y(Math.min(candle.open, candle.close));
            // A doji still needs a visible mark.
            const bodyHeight = Math.max(bodyBottom - bodyTop, 1);

            return (
              <g key={candle.timestamp}>
                <line
                  x1={centre}
                  x2={centre}
                  y1={y(candle.high)}
                  y2={y(candle.low)}
                  stroke={colour}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <rect
                  x={centre - bodyWidth / 2}
                  y={bodyTop}
                  width={bodyWidth}
                  height={bodyHeight}
                  // Filled up, hollow down: direction stays readable without
                  // depending on colour alone.
                  fill={up ? colour : 'var(--surface-1)'}
                  stroke={colour}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                  opacity={0.95}
                />
              </g>
            );
          })}
        </svg>

        {/* Price axis: real values from the rendered window. */}
        <div className="relative hidden w-16 shrink-0 flex-col justify-between border-l border-edge py-3.5 sm:flex">
          {priceTicks.map((price) => (
            <span key={price} className="tnum pl-2 text-[10px] text-text-3">
              {formatPrice(price)}
            </span>
          ))}
          {/* The latest close, tagged on the axis at its own height. */}
          <span
            className="tnum absolute left-1 rounded-[3px] border border-accent/35 bg-accent-dim px-1.5 py-[2px] text-[10px] leading-none text-accent"
            style={{ top: `${(y(last.close) / VIEW_HEIGHT) * 100}%` }}
          >
            {formatPrice(last.close)}
          </span>
        </div>
      </div>

      {/* Time axis */}
      <div className="flex items-center justify-between border-t border-edge px-4 py-2">
        {timeTicks.map((tick) => (
          <span key={tick.candle.timestamp} className="tnum text-[10px] text-text-3">
            {formatTime(tick.candle.timestamp, timeframe)}
          </span>
        ))}
        <span className={`tnum text-[10px] ${rising ? 'text-bull' : 'text-bear'}`}>
          {formatPrice(last.close)}
        </span>
      </div>
    </figure>
  );
}
