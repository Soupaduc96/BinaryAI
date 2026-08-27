import type { ReactNode } from 'react';

/**
 * Terminal primitives.
 *
 * Radius hierarchy, deliberately not uniform — "everything is a rounded card"
 * is the SaaS pattern this redesign moves away from:
 *   workspace surfaces  10px    major containers
 *   modules              8px    analytical modules
 *   tables/rows          0-4px  data surfaces
 *   controls             6px    interactive
 *   chips                4px    status
 *
 * Borders are hairlines. Information is grouped by spacing and alignment first,
 * and only boxed when the box carries meaning.
 */

export type Tone = 'neutral' | 'accent' | 'bull' | 'bear' | 'warn';

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-text-2',
  accent: 'text-accent',
  bull: 'text-bull',
  bear: 'text-bear',
  warn: 'text-warn',
};

const TONE_CHIP: Record<Tone, string> = {
  neutral: 'border-edge-strong text-text-3',
  accent: 'border-accent/25 bg-accent-dim text-accent',
  bull: 'border-bull/25 bg-bull/8 text-bull',
  bear: 'border-bear/25 bg-bear/8 text-bear',
  warn: 'border-warn/25 bg-warn/8 text-warn',
};

/** A workspace surface. One hairline, layered background, restrained radius. */
export function Surface({
  children,
  className = '',
  as: Element = 'section',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'aside' | 'article';
  'aria-labelledby'?: string;
  'aria-label'?: string;
}) {
  return (
    <Element className={`panel ${className}`} {...rest}>
      {children}
    </Element>
  );
}

/**
 * Module header. A label and an optional right-hand slot, separated from the
 * body by a hairline rather than by a heavy title bar.
 */
export function ModuleHeader({
  label,
  id,
  meta,
  action,
}: {
  label: string;
  id?: string;
  meta?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-edge px-5 py-3">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h2 id={id} className="eyebrow">
          {label}
        </h2>
        {meta ? <span className="truncate text-[11px] text-text-3">{meta}</span> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

/** Small caps label used above a value in the context strip and stat stacks. */
export function Label({ children }: { children: ReactNode }) {
  return <span className="eyebrow block">{children}</span>;
}

/**
 * A label/value pair. The vertical form used across the market context strip
 * and the decision stat stack: label above, value below, aligned on a baseline
 * grid so columns line up across modules.
 */
export function DataPair({
  label,
  value,
  tone = 'neutral',
  hint,
  mono = true,
  size = 'md',
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: string;
  mono?: boolean;
  size?: 'md' | 'lg';
}) {
  const valueClass = size === 'lg' ? 'text-[22px] leading-none' : 'text-[15px] leading-none';
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label>{label}</Label>
      <span
        className={`${mono ? 'tnum' : ''} ${valueClass} font-medium ${tone === 'neutral' ? 'text-text-1' : TONE_TEXT[tone]}`}
      >
        {value}
      </span>
      {hint ? <span className="text-[12px] leading-tight text-text-3">{hint}</span> : null}
    </div>
  );
}

/** A horizontal row of label/value pairs, e.g. inside a module body. */
export function StatRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">{children}</div>;
}

export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-[4px] border px-1.5 py-[3px] font-mono text-[10px] leading-[1.4] tracking-[0.1em] uppercase ${TONE_CHIP[tone]}`}
    >
      {children}
    </span>
  );
}

const DOT: Record<string, string> = {
  ok: 'bg-bull',
  degraded: 'bg-warn',
  unavailable: 'bg-bear',
  not_configured: 'bg-text-3',
  idle: 'bg-text-3',
};

export type HealthKind = keyof typeof DOT;

/**
 * Status dot. Never the sole carrier of state — always paired with a text
 * label, so the interface survives greyscale and colour blindness.
 */
export function StatusDot({ health }: { health: HealthKind }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-[6px] w-[6px] shrink-0 rounded-full ${DOT[health] ?? DOT['idle']}`}
    />
  );
}

/**
 * Strength meter. Renders as segments rather than a continuous bar: a segmented
 * readout reads as an instrument, and it refuses to imply precision the
 * underlying heuristic does not have.
 */
export function SegmentMeter({
  value,
  tone = 'accent',
  segments = 10,
  label,
}: {
  value: number | null;
  tone?: Tone;
  segments?: number;
  label: string;
}) {
  const filled = value === null ? 0 : Math.round(Math.min(Math.max(value, 0), 1) * segments);
  const fill = {
    neutral: 'bg-text-3',
    accent: 'bg-accent',
    bull: 'bg-bull',
    bear: 'bg-bear',
    warn: 'bg-warn',
  }[tone];

  return (
    <div
      role="meter"
      aria-valuenow={value === null ? 0 : Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="flex items-center gap-[3px]"
    >
      {Array.from({ length: segments }, (_, index) => (
        <span
          key={index}
          className={`h-3 w-[3px] rounded-[1px] transition-colors ${
            index < filled ? fill : value === null ? 'bg-edge/70' : 'bg-edge-strong'
          }`}
        />
      ))}
    </div>
  );
}

/**
 * Dormant-state block.
 *
 * The terminal spends most of its time here, so it is designed rather than
 * defaulted: it states what is absent, what would activate it, and nothing
 * that could be mistaken for data.
 */
/**
 * A module whose data is private to an account.
 *
 * Eight of these render at once when signed out, so the treatment has to be
 * quiet: a small lock glyph, one line naming what is private, and nothing else.
 * The previous version reused the empty-state block, which set a 13px uppercase
 * headline and a full sentence in every module and turned the signed-out page
 * into eight repetitions of the same paragraph.
 *
 * Deliberately compact — `py` is small and there is no min-height — because a
 * locked module should collapse to the space it needs rather than hold open a
 * card-sized void.
 */
export function Locked({
  what,
  hint,
  className = '',
}: {
  what: string;
  /**
   * A fact that holds regardless of authentication — a configuration state,
   * typically. Kept because signing in would not change it, so dropping it
   * would send a user to authenticate against a problem auth cannot fix.
   */
  hint?: string;
  className?: string;
}) {
  return (
    <div className={`flex items-start gap-2.5 px-5 py-4 ${className}`}>
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="mt-[1px] h-3.5 w-3.5 shrink-0 text-text-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      >
        <rect x="3.25" y="7" width="9.5" height="6.25" rx="1.4" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
      </svg>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-[12px] leading-relaxed text-text-3">
          <span className="font-medium text-text-2">Sign in to view.</span> {what}
        </p>
        {hint ? <p className="text-[11px] leading-relaxed text-text-3/80">{hint}</p> : null}
      </div>
    </div>
  );
}

/**
 * Headline for a feed that did not load.
 *
 * A 429 is not an outage. Labelling it "Unavailable" alongside a genuine
 * failure tells the reader the product is broken when in fact they simply
 * asked too quickly and the panel will fill itself in shortly. The project's
 * status rules already say 429 is not an error; this is that rule applied to
 * the panel a user actually looks at.
 */
export function failureHeadline(result: { readonly throttled?: boolean }): string {
  return result.throttled ? 'Rate limited' : 'Unavailable';
}

export function Dormant({
  headline,
  detail,
  hint,
  hintMono = false,
  className = '',
}: {
  headline: string;
  detail: string;
  hint?: string;
  /** Only for literal commands or endpoints. Prose hints must stay proportional. */
  hintMono?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2.5 ${className}`}>
      <p className="text-[13px] font-semibold tracking-[0.14em] text-text-2 uppercase">
        {headline}
      </p>
      <p className="max-w-md text-[13px] leading-relaxed text-text-3">{detail}</p>
      {hint ? (
        <p className={`text-[12px] leading-relaxed text-text-3/80 ${hintMono ? 'tnum' : ''}`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Placeholder for a value that does not exist yet. Never a zero. */
export function Absent() {
  return (
    <span className="text-text-3" aria-label="no data">
      —
    </span>
  );
}
