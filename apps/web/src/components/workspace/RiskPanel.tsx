import type { PersistedSignal, SystemStatus } from '@binaryai/types';
import type { ApiResult } from '@/lib/api';
import {
  Absent,
  Chip,
  ModuleHeader,
  Surface,
  TONE_TEXT,
  type Tone,
} from '@/components/ui/primitives';

/**
 * Risk assessment.
 *
 * Visually important but calm. There are no execution controls here and there
 * is nothing to add them to — the panel reports what the risk engine concluded
 * and what the platform is permitted to do, and nothing on it should read as
 * an invitation to trade.
 */

const RISK_TONE: Record<string, Tone> = {
  low: 'bull',
  medium: 'warn',
  high: 'bear',
  extreme: 'bear',
};

function Line({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-[13px] text-text-3">{label}</span>
      <span
        className={`tnum text-[13px] font-medium ${tone === 'neutral' ? 'text-text-1' : TONE_TEXT[tone]}`}
      >
        {value}
      </span>
    </div>
  );
}

export function RiskPanel({
  status,
  detail,
}: {
  status: ApiResult<SystemStatus>;
  detail: PersistedSignal | null;
}) {
  const liveDisabled = !status.ok || !status.data.liveTradingEnabled;
  const signal = detail?.signal;

  return (
    <Surface aria-labelledby="risk-heading" className="flex flex-col">
      <ModuleHeader
        label="Evalyasyon risk"
        id="risk-heading"
        action={
          <span className="flex items-center gap-2">
            {signal ? (
              <Chip tone={RISK_TONE[signal.riskLevel] ?? 'neutral'}>{signal.riskLevel}</Chip>
            ) : null}
            <Chip tone="warn">demo</Chip>
          </span>
        }
      />

      <div className="flex flex-col divide-y divide-edge/70 px-5 py-1">
        <Line
          label="Nivo risk"
          value={signal ? signal.riskLevel.toUpperCase() : <Absent />}
          tone={signal ? (RISK_TONE[signal.riskLevel] ?? 'neutral') : 'neutral'}
        />
        <Line
          label="Volatilite"
          value={
            signal?.indicators.find((indicator) => indicator.key === 'atr_percent')?.value != null
              ? `${(signal.indicators?.find((i) => i.key === 'atr_percent')?.value ?? 0).toFixed(3)}%`
              : ((<Absent />) as React.ReactNode)
          }
        />
        <Line
          label="Kalite siyal"
          value={
            signal ? (
              `${signal.confirmations?.length ?? 0} / ${signal.conflicts?.length ?? 0} conflict`
            ) : (
              <Absent />
            )
          }
        />
        <Line
          label="Kalite konfyans"
          value={signal ? signal.confidence.calibration.replace(/_/g, ' ') : <Absent />}
          tone={signal ? 'warn' : 'neutral'}
        />
        <Line
          label="Kondisyon mache"
          value={signal ? signal.marketRegime.replace(/_/g, ' ') : <Absent />}
        />
        <Line
          label="Rekòmandasyon"
          value={signal ? signal.recommendation.replace(/_/g, ' ').toUpperCase() : 'WAIT'}
          tone={signal?.recommendation === 'consider' ? 'bull' : 'warn'}
        />
      </div>

      <div className="mt-auto border-t border-edge px-5 py-4">
        <div className="flex flex-col divide-y divide-edge/70">
          <Line
            label="Trading an dirèk"
            value={liveDisabled ? 'DISABLED' : 'ENABLED'}
            tone={liveDisabled ? 'bull' : 'bear'}
          />
          <Line label="Courtier" value="NOT CONNECTED" />
          <Line label="Pozisyon ouvè" value="0" />
        </div>
        <p className="pt-3 text-[12px] leading-relaxed text-text-3">
          {signal
            ? 'Risk filters ran on this signal: confidence floor, risk ceiling, allowed regimes, volatility, data quality, exposure, daily loss, consecutive losses and cooldown.'
            : 'No market data is available for validation, so no recommendation is issued. Withholding one is the correct output, not a failure.'}
        </p>
      </div>
    </Surface>
  );
}
