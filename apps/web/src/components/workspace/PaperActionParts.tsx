import type { RiskDecisionView } from '@/lib/api-risk';

/**
 * Shared parts of the paper-action area.
 *
 * Extracted because the action surface and the position report are separate
 * components that must look identical — they occupy the same slot in the
 * decision panel, and a user moving between them should see one continuous
 * region rather than two components that merely resemble each other.
 */

export const OUTCOME_COPY: Record<string, string> = {
  allowed: 'Permitted',
  blocked: 'Refused',
  cooldown: 'Cooldown in force',
  limit_reached: 'Account limit reached',
  invalid_policy: 'Policy not coherent',
  insufficient_context: 'Cannot be acted on',
};

/** Units, trimmed of a trailing `.00`. Never a currency symbol. */
export function units(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2).replace(/\.00$/, '') : '—';
}

export function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/**
 * The paper-action region.
 *
 * A panel in its own right since the action left the decision panel: the step
 * from intelligence to a recorded action should read as a distinct stage of the
 * pipeline, not as a form appended to an analysis.
 *
 * The header states the paper boundary unconditionally — it is not a footnote
 * shown only in some states, because the one state where a user might miss it
 * is the state where they are about to act.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="paper-action-heading" className="panel flex flex-col">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-edge px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] bg-accent-dim text-[10px] font-bold text-accent"
          >
            P
          </span>
          <h2 id="paper-action-heading" className="eyebrow">
            Paper action
          </h2>
        </div>
        <span className="text-[11px] text-text-3">
          Simulated exposure only. No broker order will be placed.
        </span>
      </header>
      <div className="flex flex-col gap-3 px-5 py-4">{children}</div>
    </section>
  );
}

export function Headline({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'warn' | 'accent';
}) {
  const colour = tone === 'warn' ? 'text-warn' : tone === 'accent' ? 'text-accent' : 'text-text-1';
  return (
    <p className={`text-[13px] font-medium tracking-[0.04em] uppercase ${colour}`}>{children}</p>
  );
}

export function Line({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-2">
      <dt className="text-[11px] text-text-3">{label}</dt>
      <dd className="min-w-0 text-right text-[12px] text-text-1">{value}</dd>
    </div>
  );
}

export function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="eyebrow text-[10px]">{label}</dt>
      <dd className="tnum text-[12px] text-text-2">{value}</dd>
    </div>
  );
}

/**
 * A refusal, with the rules behind it.
 *
 * Shows the engine's own sentence for each failed rule rather than the word
 * "blocked": a refusal a user cannot act on is not an explanation.
 */
export function Refusal({ decision }: { decision: RiskDecisionView }) {
  const failed = decision.evaluations.filter((rule) => !rule.passed);
  const shown = failed.length > 0 ? failed : decision.evaluations;

  return (
    <div className="flex flex-col gap-2 rounded-[6px] border border-bear/25 bg-bear/8 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow text-bear">
          {OUTCOME_COPY[decision.outcome] ?? decision.outcome}
        </span>
        {decision.retryAfterMs !== null ? (
          <span className="tnum text-[11px] text-warn">
            clears in {Math.ceil(decision.retryAfterMs / 1000)}s
          </span>
        ) : null}
      </div>
      <ul className="flex flex-col gap-1">
        {shown.slice(0, 4).map((rule) => (
          <li key={rule.code} className="text-[11px] text-text-2">
            {rule.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function messageOf(payload: Record<string, unknown> | null, fallback: string): string {
  const error = payload?.['error'];
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return fallback;
}
