'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react';
import { IconExpand, IconIndicator, IconLayers } from '@/components/ui/icons';
import {
  CHART_OVERLAYS,
  OSCILLATORS,
  PRICE_INDICATORS,
  readIndicators,
  readOverlays,
} from '@/lib/chart-overlays';

/**
 * The chart's own controls: indicators, overlays and fullscreen.
 *
 * These were previously three disabled buttons with "available in a later
 * phase" titles. That was honest about the state and useless as a product — a
 * control that looks like a button and does nothing is a defect regardless of
 * how truthfully it is labelled.
 *
 * Now each does the real thing:
 *
 *  - **Indicators / Overlays** open a genuine control surface and write the
 *    selection to the URL, which the server reads to compute lines from the
 *    stored candles. Same state model as the timeframe control: shareable,
 *    survives a refresh, and needs no charting runtime in the browser.
 *  - **Fullscreen** calls the Fullscreen API on the chart element. It reflects
 *    the real document state rather than a local boolean, so pressing Escape
 *    updates the button too.
 *
 * What is deliberately NOT offered: oscillators over the price scale. They are
 * listed in the panel with the reason, because an empty section reads as
 * breakage while a misleading line would be worse than either.
 */

/** Toggles one id inside a comma-separated URL parameter. */
function toggled(current: readonly string[], id: string): string[] {
  return current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
}

function ToolButton({
  label,
  expanded,
  controls,
  onClick,
  active,
  children,
}: {
  label: string;
  expanded?: boolean;
  controls?: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
      {...(controls === undefined ? {} : { 'aria-controls': controls })}
      className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors ${
        active || expanded
          ? 'border-accent/40 bg-accent/10 text-text-1'
          : 'border-edge text-text-3 hover:border-edge-strong hover:text-text-2'
      }`}
    >
      {children}
    </button>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  detail,
  colour,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  detail: string;
  colour?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`flex w-full items-start gap-2.5 rounded-[6px] border px-2.5 py-2 text-left transition-colors ${
        checked
          ? 'border-accent/40 bg-accent/[0.07]'
          : 'border-edge bg-surface-2 hover:border-edge-strong'
      }`}
    >
      <span
        aria-hidden
        className="mt-[3px] h-2.5 w-2.5 shrink-0 rounded-[3px] border"
        style={{
          borderColor: checked && colour ? colour : 'var(--edge-strong)',
          background: checked && colour ? colour : 'transparent',
        }}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={`text-[12px] ${checked ? 'text-text-1' : 'text-text-2'}`}>{label}</span>
        <span className="text-[10.5px] leading-relaxed text-text-3">{detail}</span>
      </span>
    </button>
  );
}

export function ChartTools({ targetId }: { targetId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const panelId = useId();

  const [open, setOpen] = useState<'indicators' | 'overlays' | null>(null);
  const [isFullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const indicators = readIndicators(params.get('ind') ?? undefined);
  const overlays = readOverlays(params.get('ov') ?? undefined);

  const write = useCallback(
    (key: 'ind' | 'ov', next: readonly string[]): void => {
      const search = new URLSearchParams(params.toString());
      if (next.length === 0) search.delete(key);
      else search.set(key, next.join(','));
      startTransition(() => {
        router.replace(`?${search.toString()}`, { scroll: false });
      });
    },
    [params, router],
  );

  // The document is the source of truth for fullscreen, not this component:
  // Escape and the browser's own controls exit it without going through the
  // button, and a local boolean would then be wrong.
  useEffect(() => {
    const sync = (): void => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', sync);
    sync();
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  // Escape closes an open panel, which is what a keyboard user expects of
  // anything that opened over the page.
  useEffect(() => {
    if (open === null) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const toggleFullscreen = useCallback((): void => {
    const target = document.getElementById(targetId);
    if (!target) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void target.requestFullscreen?.().catch(() => undefined);
  }, [targetId]);

  const activePanel = open;

  return (
    <div ref={containerRef} className="relative flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        <ToolButton
          label="Endikatè"
          expanded={activePanel === 'indicators'}
          controls={`${panelId}-indicators`}
          active={indicators.length > 0}
          onClick={() => setOpen(activePanel === 'indicators' ? null : 'indicators')}
        >
          <IconIndicator size={14} />
          <span className="hidden sm:inline">Endikatè</span>
          {indicators.length > 0 ? (
            <span className="tnum text-[11px]">{indicators.length}</span>
          ) : null}
        </ToolButton>

        <ToolButton
          label="Kouch"
          expanded={activePanel === 'overlays'}
          controls={`${panelId}-overlays`}
          active={overlays.length > 0}
          onClick={() => setOpen(activePanel === 'overlays' ? null : 'overlays')}
        >
          <IconLayers size={14} />
          <span className="hidden sm:inline">Kouch</span>
          {overlays.length > 0 ? <span className="tnum text-[11px]">{overlays.length}</span> : null}
        </ToolButton>

        <ToolButton
          label={isFullscreen ? 'Sòti nan plen ekran' : 'Plen ekran'}
          active={isFullscreen}
          onClick={toggleFullscreen}
        >
          <IconExpand size={14} />
        </ToolButton>
      </div>

      {activePanel === 'indicators' ? (
        <div
          id={`${panelId}-indicators`}
          className={`panel absolute top-9 right-0 z-30 flex w-[290px] flex-col gap-1.5 p-2.5 ${
            pending ? 'opacity-70' : ''
          }`}
        >
          <p className="telemetry-label px-1 pb-0.5">Price overlays</p>
          {PRICE_INDICATORS.map((indicator) => (
            <Toggle
              key={indicator.id}
              checked={indicators.includes(indicator.id)}
              onChange={() => write('ind', toggled(indicators, indicator.id))}
              label={indicator.label}
              detail={indicator.detail}
              colour={indicator.colour}
            />
          ))}

          <p className="telemetry-label px-1 pt-2 pb-0.5">Not drawn on this scale</p>
          {OSCILLATORS.map((oscillator) => (
            <div key={oscillator.id} className="rounded-[6px] border border-edge/60 px-2.5 py-1.5">
              <p className="text-[12px] text-text-3">{oscillator.label}</p>
              <p className="text-[10.5px] leading-relaxed text-text-3/80">{oscillator.reason}</p>
            </div>
          ))}
          <p className="px-1 pt-1 text-[10.5px] leading-relaxed text-text-3">
            Computed from the stored candles with the same functions the engine uses. Nothing is
            interpolated.
          </p>
        </div>
      ) : null}

      {activePanel === 'overlays' ? (
        <div
          id={`${panelId}-overlays`}
          className={`panel absolute top-9 right-0 z-30 flex w-[290px] flex-col gap-1.5 p-2.5 ${
            pending ? 'opacity-70' : ''
          }`}
        >
          <p className="telemetry-label px-1 pb-0.5">Chart overlays</p>
          {CHART_OVERLAYS.map((overlay) => (
            <Toggle
              key={overlay.id}
              checked={overlays.includes(overlay.id)}
              onChange={() => write('ov', toggled(overlays, overlay.id))}
              label={overlay.label}
              detail={overlay.detail}
              colour={overlay.colour}
            />
          ))}
          <p className="px-1 pt-1 text-[10.5px] leading-relaxed text-text-3">
            Markers are drawn only where a signal was actually recorded for this instrument and
            timeframe.
          </p>
        </div>
      ) : null}
    </div>
  );
}
