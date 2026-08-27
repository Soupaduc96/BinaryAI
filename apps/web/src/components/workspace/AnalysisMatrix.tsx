import type { IndicatorSnapshot, PersistedSignal } from '@binaryai/types';
import {
  Absent,
  Chip,
  ModuleHeader,
  SegmentMeter,
  Surface,
  type Tone,
} from '@/components/ui/primitives';

/**
 * Market analysis, as an analytical matrix rather than a wall of small cards.
 *
 * Each row is one dimension of market state: reading, state, strength.
 *
 * On honesty: the STATE column is the engine's own `interpretation` for that
 * indicator — it is not re-derived here. The STRENGTH meter is a display
 * normalisation applied ONLY to indicators with a natural bounded scale
 * (RSI 0-100, ADX 0-100, %B 0-1). Unbounded readings such as ATR% show their
 * value with no meter, because any bound would be invented.
 */

const REGIME_LABEL: Record<string, string> = {
  trend_up: 'Trend up',
  trend_down: 'Trend down',
  range: 'Range',
  volatile: 'High volatility',
  quiet: 'Low volatility',
  unknown: 'Unclassified',
};

const STATE_TONE: Record<string, Tone> = {
  bullish: 'bull',
  bearish: 'bear',
  neutral: 'neutral',
  unavailable: 'neutral',
};

interface Row {
  readonly metric: string;
  readonly reading: string | null;
  readonly state: string | null;
  readonly tone: Tone;
  readonly strength: number | null;
}

const DORMANT_ROWS: readonly Row[] = ['Trend', 'Momentum', 'Volatility', 'Regime', 'Structure'].map(
  (metric) => ({ metric, reading: null, state: null, tone: 'neutral' as Tone, strength: null }),
);

function pick(
  indicators: readonly IndicatorSnapshot[],
  key: string,
): IndicatorSnapshot | undefined {
  return indicators.find((indicator) => indicator.key === key);
}

function format(value: number | null | undefined, suffix = ''): string | null {
  if (value === null || value === undefined) return null;
  const absolute = Math.abs(value);
  const decimals = absolute >= 100 ? 1 : absolute >= 1 ? 2 : 4;
  return `${value.toFixed(decimals).replace(/\.?0+$/, '')}${suffix}`;
}

function buildRows(detail: PersistedSignal): readonly Row[] {
  const { signal } = detail;
  // Defensive: `signal` is a stored JSON snapshot, and a row written before a
  // field existed will not have it. A missing array must degrade to the dormant
  // readout, never take the whole page down with it.
  const indicators = signal.indicators ?? [];

  const adx = pick(indicators, 'adx');
  const rsi = pick(indicators, 'rsi');
  const atr = pick(indicators, 'atr_percent');
  const percentB = pick(indicators, 'bb_percent_b');

  const trendDirection =
    signal.marketRegime === 'trend_up'
      ? 'Up'
      : signal.marketRegime === 'trend_down'
        ? 'Down'
        : 'Flat';

  return [
    {
      metric: 'Trend',
      reading: format(adx?.value) ?? null,
      state: adx?.value === null || adx === undefined ? null : trendDirection,
      tone:
        signal.marketRegime === 'trend_up'
          ? 'bull'
          : signal.marketRegime === 'trend_down'
            ? 'bear'
            : 'neutral',
      // ADX is bounded 0-100; 50 is a conventional display ceiling for strength.
      strength: adx?.value === null || adx === undefined ? null : Math.min(adx.value / 50, 1),
    },
    {
      metric: 'Momentum',
      reading: format(rsi?.value) ?? null,
      state: rsi ? rsi.interpretation : null,
      tone: rsi ? (STATE_TONE[rsi.interpretation] ?? 'neutral') : 'neutral',
      strength: rsi?.value === null || rsi === undefined ? null : Math.abs(rsi.value - 50) / 50,
    },
    {
      metric: 'Volatility',
      reading: format(atr?.value, '%') ?? null,
      state: atr ? atr.interpretation : null,
      tone: 'neutral',
      // ATR% has no natural ceiling; a meter here would imply a bound we invented.
      strength: null,
    },
    {
      metric: 'Regime',
      reading: null,
      state: REGIME_LABEL[signal.marketRegime] ?? 'Unclassified',
      tone: 'neutral',
      strength: null,
    },
    {
      metric: 'Structure',
      reading: format(percentB?.value) ?? null,
      state: percentB ? percentB.interpretation : null,
      tone: percentB ? (STATE_TONE[percentB.interpretation] ?? 'neutral') : 'neutral',
      strength:
        percentB?.value === null || percentB === undefined
          ? null
          : Math.min(Math.max(percentB.value, 0), 1),
    },
  ];
}

export function AnalysisMatrix({ detail }: { detail: PersistedSignal | null }) {
  const rows = detail ? buildRows(detail) : DORMANT_ROWS;
  const indicatorCount = detail?.signal.indicators?.length ?? 0;

  return (
    <Surface aria-labelledby="analysis-heading" className="flex flex-col">
      <ModuleHeader
        label="Market Analysis"
        id="analysis-heading"
        meta={detail ? `${indicatorCount} readings` : 'awaiting data'}
      />

      <div className="px-2 py-1">
        <table className="w-full border-collapse">
          <caption className="sr-only">
            Market analysis by dimension: reading, state and strength
          </caption>
          <thead>
            <tr>
              {['Metric', 'Reading', 'State', 'Strength'].map((heading, index) => (
                <th
                  key={heading}
                  scope="col"
                  className={`eyebrow px-3 pt-3 pb-2 font-semibold ${
                    index === 0 ? 'text-left' : index === 3 ? 'text-right' : 'text-left'
                  }`}
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.metric} className="border-t border-edge/70">
                <th scope="row" className="px-3 py-3 text-left text-[13px] font-medium text-text-1">
                  {row.metric}
                </th>
                <td className="tnum px-3 py-3 text-[13px] text-text-2">
                  {row.reading ?? <Absent />}
                </td>
                <td className="px-3 py-3">
                  {row.state ? (
                    <Chip tone={row.tone}>{row.state}</Chip>
                  ) : (
                    <span className="text-[13px]">
                      <Absent />
                    </span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <span className="flex justify-end">
                    <SegmentMeter
                      value={row.strength}
                      tone={row.tone === 'neutral' ? 'accent' : row.tone}
                      segments={8}
                      label={`${row.metric} strength`}
                    />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!detail ? (
        <p className="border-t border-edge px-5 py-3 text-[12px] leading-relaxed text-text-3">
          Dimensions populate once a validated series has been analysed.
        </p>
      ) : null}
    </Surface>
  );
}
