import type { ReactNode } from 'react';

/**
 * The status vocabulary, as one component.
 *
 * Every state in BinaryAI — LIVE, STALE, NO DATA, AVAILABLE, NOT CONFIGURED,
 * ERROR, RATE LIMITED, UNSUPPORTED — resolves through here, so the same fact
 * cannot wear two different appearances in two different modules.
 *
 * **Colour is never the only carrier.** Each kind gets a distinct GLYPH SHAPE
 * as well as a hue: a filled ring for live, a hollow ring for idle, a bar for
 * degraded, a cross for error, a slash for unsupported. The interface therefore
 * survives greyscale, colour blindness and a printout — which matters here more
 * than in most products, because these states are the difference between "this
 * number is current" and "this number is four hours old".
 */

export type StatusKind =
  /** Answering, current, verified. */
  | 'live'
  /** Configured and working, but not a live feed. */
  | 'ok'
  /** Working with a caveat: stale data, degraded component, throttled. */
  | 'warn'
  /** Failed. */
  | 'bad'
  /** Deliberately absent: not configured, no data yet, waiting. */
  | 'idle'
  /** Refused by design: unsupported instrument, unavailable capability. */
  | 'unsupported'
  /** Neutral information. */
  | 'info';

const SURFACE: Record<StatusKind, string> = {
  live: 'status-live',
  ok: 'status-ok',
  warn: 'status-warn',
  bad: 'status-bad',
  idle: 'status-idle',
  unsupported: 'status-idle',
  info: 'status-info',
};

/**
 * The glyph for each kind, drawn rather than coloured.
 *
 * Shapes are chosen so they differ in SILHOUETTE, not merely in fill: a reader
 * who cannot distinguish the hues can still tell a live ring from an error
 * cross at 10px.
 */
function Glyph({ kind }: { kind: StatusKind }) {
  const common = {
    viewBox: '0 0 10 10',
    className: 'h-[9px] w-[9px] shrink-0',
    'aria-hidden': true,
  };

  switch (kind) {
    case 'live':
      // Filled core inside a ring: something is actively transmitting.
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.2">
          <circle cx="5" cy="5" r="3.6" />
          <circle cx="5" cy="5" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'ok':
      // A check: configured and correct.
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M2 5.3 4.2 7.5 8 3" />
        </svg>
      );
    case 'warn':
      // A half-filled bar: working, but not fully.
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="1.4" y="3.2" width="7.2" height="3.6" rx="1" />
          <rect x="1.4" y="3.2" width="3.6" height="3.6" rx="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'bad':
      // A cross: failed.
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2.6 2.6l4.8 4.8M7.4 2.6l-4.8 4.8" />
        </svg>
      );
    case 'unsupported':
      // A barred circle: refused by design, not broken.
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <circle cx="5" cy="5" r="3.6" />
          <path d="M2.5 7.5 7.5 2.5" />
        </svg>
      );
    case 'info':
      // A solid dot: neutral, present.
      return (
        <svg {...common} fill="currentColor">
          <circle cx="5" cy="5" r="2.6" />
        </svg>
      );
    case 'idle':
    default:
      // A hollow ring: nothing here, and nothing wrong.
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.2">
          <circle cx="5" cy="5" r="3.4" strokeDasharray="1.6 1.6" />
        </svg>
      );
  }
}

/**
 * A status pill: glyph, then the state in words.
 *
 * The label is never optional. A bare coloured dot is an abbreviation the
 * reader has to have been taught, and this product cannot assume that.
 */
export function StatusPill({
  kind,
  label,
  title,
  className = '',
}: {
  kind: StatusKind;
  label: string;
  title?: string;
  className?: string;
}) {
  return (
    <span
      {...(title ? { title } : {})}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[9.5px] leading-none tracking-[0.13em] uppercase ${SURFACE[kind]} ${className}`}
    >
      <Glyph kind={kind} />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * The glyph on its own, for dense rows where a pill would not fit.
 *
 * Takes an accessible `label` regardless, because the shape alone is still an
 * abbreviation — it is exposed to assistive technology even when the sighted
 * layout has no room for words.
 */
export function StatusMark({ kind, label }: { kind: StatusKind; label: string }) {
  const tone = {
    live: 'text-cyan',
    ok: 'text-bull',
    warn: 'text-warn',
    bad: 'text-bear',
    idle: 'text-text-3',
    unsupported: 'text-text-3',
    info: 'text-accent',
  }[kind];

  return (
    <span className={`inline-flex items-center ${tone}`} title={label}>
      <Glyph kind={kind} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Maps the system-state indicator tones onto the status vocabulary.
 *
 * `lib/system-state` decides what ONLINE / DEGRADED / NOT CONFIGURED mean; this
 * decides only how they look. Keeping the two separate is what stops a styling
 * change from quietly altering a health verdict.
 */
export function kindFromTone(
  tone: 'ok' | 'warn' | 'bad' | 'idle' | 'info',
  value?: string,
): StatusKind {
  if (tone === 'ok') return value === 'LIVE' ? 'live' : 'ok';
  if (tone === 'warn') return 'warn';
  if (tone === 'bad') return 'bad';
  if (tone === 'info') return 'info';
  return 'idle';
}

/** A section of status rows, used in the system page and the status menu. */
export function StatusList({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col divide-y divide-edge/70">{children}</ul>;
}
