import type { ReactNode } from 'react';

/**
 * The title block every workspace opens with.
 *
 * Each route is a destination rather than a scroll position, so each states its
 * job in one line and the modules below become evidence for that job. Without
 * it a reader arriving at /ledger sees modules and has to infer the purpose
 * from them.
 *
 * The eyebrow above the title names the SECTION, so a reader always knows where
 * in the product they are standing without consulting the rail — which matters
 * on a narrow screen, where the rail has collapsed to a strip.
 */
export function WorkspaceHeader({
  eyebrow,
  title,
  lede,
  meta,
  action,
}: {
  /** The section this route belongs to, matching the rail's grouping. */
  eyebrow?: string;
  title: string;
  lede: string;
  /** Short factual annotation, e.g. a count. Never a claim. */
  meta?: string | undefined;
  /** A control that belongs to the page as a whole. */
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pt-0.5">
      <div className="flex min-w-0 flex-col gap-2">
        {eyebrow ? (
          <span className="flex items-center gap-2">
            {/* A short accent rule before the eyebrow: it gives the page a
                starting mark, and ties the header to the rail's active bar. */}
            <span aria-hidden className="h-[2px] w-5 rounded-full bg-accent" />
            <span className="telemetry-label">{eyebrow}</span>
          </span>
        ) : null}
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="page-title">{title}</h1>
          {meta ? <span className="tnum text-[11px] text-text-3">{meta}</span> : null}
        </div>
        <p className="max-w-3xl text-[12.5px] leading-relaxed text-text-3">{lede}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
