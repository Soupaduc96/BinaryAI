import type { Candle } from '@binaryai/types';
import { bollingerBands, ema, sma } from '@binaryai/indicators';

/**
 * What the chart can draw, and the state that says which of it is drawn.
 *
 * Two rules govern this catalogue, and both are about not lying with a picture:
 *
 *  1. **Everything here is computed from the stored candles.** These are the
 *     same functions the engine uses (`@binaryai/indicators`), applied to the
 *     same validated closes. A line on the chart is arithmetic on real bars,
 *     never a smoothed, interpolated or illustrative curve.
 *
 *  2. **Only overlays that share the price scale are offered.** RSI, ADX and
 *     ATR are real and the engine computes them, but they live on their own
 *     scale and drawing them over price would produce a line that means
 *     nothing. Offering a toggle that renders a misleading line would be worse
 *     than not offering it, so they are named as unavailable with the reason
 *     rather than silently omitted.
 *
 * The selection lives in the URL, exactly as the timeframe does: it survives a
 * refresh, it is shareable, and the server can render the result without a
 * client-side charting runtime.
 */

export interface OverlayDefinition {
  readonly id: string;
  readonly label: string;
  /** Shown in the control surface so a reader knows what the line is. */
  readonly detail: string;
  readonly colour: string;
}

/** Price-scale indicators: drawable over candles without distorting meaning. */
export const PRICE_INDICATORS: readonly OverlayDefinition[] = [
  {
    id: 'ema12',
    label: 'EMA 12',
    detail: 'Mwayèn mobil eksponansyèl, 12 bouji',
    colour: 'var(--accent)',
  },
  {
    id: 'ema26',
    label: 'EMA 26',
    detail: 'Mwayèn mobil eksponansyèl, 26 bouji',
    colour: '#e0a33c',
  },
  { id: 'sma50', label: 'SMA 50', detail: 'Mwayèn mobil senp, 50 bouji', colour: '#8b9cc4' },
  {
    id: 'bb20',
    label: 'Bollinger 20',
    detail: 'SMA 20 bouji ak ±2 devyasyon estanda',
    colour: '#5f7a9e',
  },
];

/**
 * Indicators the engine computes but the price chart cannot honestly show.
 *
 * Listed so the control surface can say why they are absent. An empty panel
 * invites the reader to assume the feature is broken; a stated reason is the
 * truthful alternative to both silence and a misleading line.
 */
export const OSCILLATORS: readonly { id: string; label: string; reason: string }[] = [
  {
    id: 'rsi',
    label: 'RSI 14',
    reason: 'Limite 0–100 — li bezwen pwòp panno pa l, se pa echèl pri a.',
  },
  {
    id: 'adx',
    label: 'ADX 14',
    reason: 'Limite 0–100 — li bezwen pwòp panno pa l, se pa echèl pri a.',
  },
  { id: 'atr', label: 'ATR 14', reason: 'Mezire an inite pri, se pa pri — yon panno apa.' },
];

/** Non-indicator overlays drawn from data the page already holds. */
export const CHART_OVERLAYS: readonly OverlayDefinition[] = [
  {
    id: 'signals',
    label: 'Makè siyal',
    detail: 'Kote BinaryAI anrejistre yon desizyon sou enstriman ak entèval sa a',
    colour: 'var(--accent)',
  },
  {
    id: 'last',
    label: 'Dènye pri',
    detail: 'Yon liy sou dènye fèmti a',
    colour: '#3ecf8e',
  },
];

const VALID_INDICATORS = new Set(PRICE_INDICATORS.map((i) => i.id));
const VALID_OVERLAYS = new Set(CHART_OVERLAYS.map((o) => o.id));

/** Parses a comma-separated URL parameter, discarding anything unrecognised. */
function parseSelection(value: string | string[] | undefined, valid: Set<string>): string[] {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => valid.has(entry));
}

export function readIndicators(value: string | string[] | undefined): string[] {
  return parseSelection(value, VALID_INDICATORS);
}

export function readOverlays(value: string | string[] | undefined): string[] {
  return parseSelection(value, VALID_OVERLAYS);
}

export interface IndicatorLine {
  readonly id: string;
  readonly label: string;
  readonly colour: string;
  /** One entry per candle; null where the indicator has not warmed up yet. */
  readonly values: readonly (number | null)[];
  /** Dashed lines mark a band edge rather than a line in its own right. */
  readonly dashed?: boolean;
}

/**
 * Computes the selected indicators over the given candles.
 *
 * A `null` inside a series is a genuine absence — the warm-up period before an
 * average has enough bars — and is preserved rather than back-filled, so the
 * line starts where the maths actually starts.
 */
export function computeIndicatorLines(
  candles: readonly Candle[],
  selected: readonly string[],
): IndicatorLine[] {
  if (candles.length === 0 || selected.length === 0) return [];
  const closes = candles.map((candle) => candle.close);
  const lines: IndicatorLine[] = [];

  for (const definition of PRICE_INDICATORS) {
    if (!selected.includes(definition.id)) continue;

    if (definition.id === 'ema12') {
      lines.push({ ...definition, values: ema(closes, 12) });
    } else if (definition.id === 'ema26') {
      lines.push({ ...definition, values: ema(closes, 26) });
    } else if (definition.id === 'sma50') {
      lines.push({ ...definition, values: sma(closes, 50) });
    } else if (definition.id === 'bb20') {
      // Three lines from one toggle: a band is not meaningful as a single
      // curve, and showing only the middle would misrepresent what was asked
      // for.
      const bands = bollingerBands(closes, 20, 2);
      lines.push(
        { ...definition, label: 'Bollinger upper', values: bands.upper, dashed: true },
        { ...definition, label: 'Bollinger middle', values: bands.middle },
        { ...definition, label: 'Bollinger lower', values: bands.lower, dashed: true },
      );
    }
  }

  return lines;
}
