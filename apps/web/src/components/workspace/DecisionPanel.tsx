import type { PersistedSignal, Signal } from '@binaryai/types';
import type { ApiResult, SignalFeed } from '@/lib/api';
import { IconChevron } from '@/components/ui/icons';
import { Absent, Label, SegmentMeter, TONE_TEXT, type Tone } from '@/components/ui/primitives';

/**
 * The AI Decision Center — BinaryAI's intelligence layer.
 *
 * Deliberately not shaped like the analytical modules around it: a single
 * vertical column with its own rhythm, an accent-lit top edge, and one
 * dominant statement. Intelligence is communicated through analysis,
 * typography and reasoning — not through sparkles, chat bubbles or gradients.
 *
 * Two rules that cannot be relaxed:
 *   1. A decision renders only from a signal the engine actually produced.
 *   2. Confidence never appears without its calibration status attached.
 */

const REGIME_LABEL: Record<string, string> = {
  trend_up: 'TREND UP',
  trend_down: 'TREND DOWN',
  range: 'RANGE',
  volatile: 'HIGH VOLATILITY',
  quiet: 'LOW VOLATILITY',
  unknown: 'UNCLASSIFIED',
};

const RISK_TONE: Record<string, Tone> = {
  low: 'bull',
  medium: 'warn',
  high: 'bear',
  extreme: 'bear',
};

interface DecisionView {
  readonly headline: string;
  readonly tone: Tone;
  readonly caption: string;
}

/**
 * The recommendation drives the headline, not the raw direction: a CALL the
 * risk engine blocked is not a CALL the user should read as actionable.
 */
function resolveView(signal: Signal): DecisionView {
  const direction = signal.direction.toUpperCase();

  if (signal.direction === 'none') {
    return {
      headline: 'NO SIGNAL',
      tone: 'neutral',
      caption: signal.reasoning?.summary ?? 'No reasoning was recorded for this signal.',
    };
  }
  if (signal.recommendation === 'consider') {
    return {
      headline: direction,
      tone: signal.direction === 'call' ? 'bull' : 'bear',
      caption: 'Passed every risk check. Decision support only.',
    };
  }
  if (signal.recommendation === 'wait_for_confirmation') {
    return {
      headline: 'WAIT',
      tone: 'warn',
      caption: `${direction} candidate identified, confirmation incomplete.`,
    };
  }
  return {
    headline: 'NO SIGNAL',
    tone: 'neutral',
    caption: `${direction} candidate rejected by the risk engine.`,
  };
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="decision-heading"
      className="panel panel-elevated relative flex flex-col overflow-hidden"
    >
      {/* Accent-lit top edge: marks the intelligence layer without decoration. */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(ellipse_at_top,var(--accent-dim),transparent_70%)]"
      />
      {children}
    </section>
  );
}

function Divider() {
  return <span aria-hidden className="block h-px bg-edge" />;
}

/** Stat line used down the decision column. */
function Stat({
  label,
  value,
  tone = 'neutral',
  meter,
}: {
  label: string;
  value: React.ReactNode;
  tone?: Tone;
  meter?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <span className="telemetry-label">{label}</span>
      <span className="flex items-center gap-3">
        {meter}
        <span
          className={`tnum text-[13px] font-medium ${tone === 'neutral' ? 'text-text-1' : TONE_TEXT[tone]}`}
        >
          {value}
        </span>
      </span>
    </div>
  );
}

export function DecisionPanel({
  feed,
  detail,
}: {
  feed: ApiResult<SignalFeed>;
  detail: PersistedSignal | null;
  /** Drives the paper-action step; the backend authorizes regardless. */
}) {
  const unreachable = !feed.ok;
  const dormant = feed.ok && (feed.data.signals.length === 0 || !detail);

  if (unreachable || dormant) {
    const headline = unreachable ? 'UNAVAILABLE' : 'WAIT';
    const caption = unreachable
      ? 'The API is unreachable, so no decision can be shown.'
      : 'Market conditions not yet validated.';
    const why = unreachable
      ? feed.error
      : ((feed.ok && feed.data.reason) ??
        'BinaryAI produces a decision only from validated market data. No provider is connected.');

    return (
      <Frame>
        <header className="relative flex items-center justify-between gap-3 px-5 py-3">
          <h2 id="decision-heading" className="eyebrow text-accent/80">
            AI Decision
          </h2>
          <span className="font-mono text-[11px] tracking-wider text-text-3 uppercase">
            rule engine
          </span>
        </header>
        <Divider />

        <div className="relative flex flex-col gap-3 px-5 py-7">
          <p
            className={`text-[42px] leading-none font-semibold tracking-tight ${unreachable ? 'text-bear' : 'text-warn'}`}
          >
            {headline}
          </p>
          <p className="text-[13px] leading-relaxed text-text-3">{caption}</p>
        </div>

        <Divider />
        <div className="flex flex-col divide-y divide-edge">
          <Stat label="Confidence" value={<Absent />} />
          <Stat label="Market regime" value={<Absent />} />
          <Stat label="Signal quality" value={<Absent />} />
          <Stat label="Risk" value={<Absent />} />
        </div>

        <Divider />
        <div className="flex flex-col gap-2 px-5 py-4">
          <Label>Why</Label>
          <p className="text-[13px] leading-relaxed text-text-3">{why}</p>
        </div>
      </Frame>
    );
  }

  // From here a real signal exists; every value below comes from the engine.
  const { signal } = detail as PersistedSignal;
  const view = resolveView(signal);
  const confidence = Math.round(signal.confidence.score * 100);
  const calibrated = signal.confidence.calibration !== 'uncalibrated_heuristic';
  // Stored snapshots may predate a field. Missing evidence degrades to zero
  // rather than crashing the workspace.
  const confirmations = signal.confirmations?.length ?? 0;
  const conflicts = signal.conflicts?.length ?? 0;

  return (
    <Frame>
      <header className="relative flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-5 py-3.5">
        <h2 id="decision-heading" className="eyebrow text-accent/80">
          AI Decision
        </h2>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[10.5px] tracking-wider text-text-3 uppercase">
            {signal.strategy.name}
          </span>
          <span className="tnum shrink-0 text-[10px] text-text-3">v{signal.strategy.version}</span>
        </span>
      </header>
      <Divider />

      <div className="relative grid gap-x-6 gap-y-5 px-5 py-7 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="flex min-w-0 flex-col gap-2.5">
          <p className={`display-decision ${TONE_TEXT[view.tone]}`}>{view.headline}</p>
          <p className="max-w-[38ch] text-[12.5px] leading-relaxed text-text-3">{view.caption}</p>
        </div>

        {/* Confidence, set apart on its own hairline surface so it reads as a
            qualification of the decision rather than as a rival headline. */}
        <div className="flex flex-col gap-1.5 rounded-[8px] border border-edge bg-surface-2/60 px-4 py-3 sm:min-w-[172px]">
          <span className="telemetry-label">
            {calibrated ? 'calibrated' : 'heuristic'} confidence
          </span>
          <span className="tnum display-value text-text-1">{confidence}%</span>
          {/* The number is never shown without what it is not. */}
          {!calibrated ? (
            <span className="text-[10.5px] leading-relaxed text-warn/80">
              Not a win probability
            </span>
          ) : null}
        </div>
      </div>

      <Divider />
      <div className="flex flex-col divide-y divide-edge">
        <Stat label="Market regime" value={REGIME_LABEL[signal.marketRegime] ?? 'UNCLASSIFIED'} />
        <Stat
          label="Signal quality"
          value={`${confirmations}/${confirmations + conflicts}`}
          meter={
            <SegmentMeter
              value={signal.confidence.score}
              tone={view.tone === 'neutral' ? 'accent' : view.tone}
              segments={8}
              label={`Signal quality, ${confidence} percent heuristic confidence`}
            />
          }
        />
        <Stat
          label="Risk"
          value={signal.riskLevel.toUpperCase()}
          tone={RISK_TONE[signal.riskLevel] ?? 'neutral'}
        />
        <Stat label="Expiration" value={`${signal.expiration.seconds}s`} />
      </div>

      <Divider />
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3.5 transition-colors hover:bg-surface-2">
          <Label>Why</Label>
          <span className="flex items-center gap-2 text-[12px] text-text-3">
            {confirmations} confirmation{confirmations === 1 ? '' : 's'} · {conflicts} conflict
            {conflicts === 1 ? '' : 's'}
            <IconChevron size={14} className="transition-transform group-open:rotate-180" />
          </span>
        </summary>

        <div className="flex flex-col gap-5 px-5 pb-5">
          <p className="text-[13px] leading-relaxed text-text-2">
            {signal.reasoning?.summary ?? 'No reasoning was recorded for this signal.'}
          </p>
          <ReasonGroup title="Supporting" items={signal.reasoning?.supporting ?? []} tone="bull" />
          <ReasonGroup title="Conflicting" items={signal.reasoning?.opposing ?? []} tone="bear" />
          <ReasonGroup title="Caveats" items={signal.reasoning.caveats} tone="warn" />
        </div>
      </details>
    </Frame>
  );
}

function ReasonGroup({
  title,
  items,
  tone,
}: {
  title: string;
  items: readonly string[] | undefined;
  tone: Tone;
}) {
  if (!items || items.length === 0) return null;
  const marker = {
    neutral: 'bg-text-3',
    accent: 'bg-accent',
    bull: 'bg-bull',
    bear: 'bg-bear',
    warn: 'bg-warn',
  }[tone];

  return (
    <div className="flex flex-col gap-2">
      <Label>{title}</Label>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-[12px] leading-relaxed text-text-3">
            <span aria-hidden className={`mt-[7px] h-1 w-1 shrink-0 rounded-full ${marker}`} />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
