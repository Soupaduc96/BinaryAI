'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ComponentStatus } from '@binaryai/types';
import { TONE_TEXT, type Indicator } from '@/lib/system-state';
import { StatusMark, kindFromTone } from '@/components/ui/status';

/**
 * The operating-state cluster, made openable.
 *
 * The pills always reported real state, but their explanation lived in a `title`
 * attribute — invisible on a touch device, unreachable by keyboard, and gone the
 * moment the pointer moves. The summary was useful and the detail behind it was
 * effectively unavailable.
 *
 * Now the cluster is a button that opens the same component list the status
 * endpoint returns, with each component's own sentence. Nothing here is
 * computed or softened: the health and the detail are exactly what the API
 * said, which is what makes it worth reading during an incident.
 */

const HEALTH_TONE: Record<string, string> = {
  ok: 'text-bull',
  degraded: 'text-warn',
  unavailable: 'text-bear',
  not_configured: 'text-text-3',
};

const HEALTH_DOT: Record<string, string> = {
  ok: 'bg-bull',
  degraded: 'bg-warn',
  unavailable: 'bg-bear',
  not_configured: 'bg-text-3/50',
};

function label(component: string): string {
  return component.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function StatusMenu({
  pills,
  components,
}: {
  pills: readonly { label: string; indicator: Indicator }[];
  /** Straight from /v1/system/status. Empty when the call did not succeed. */
  components: readonly ComponentStatus[];
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onClick = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <div className="relative hidden lg:block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Eta sistèm nan — louvri pou detay"
        className={`flex items-center divide-x divide-edge/80 rounded-lg border bg-surface-2/50 [&>*]:px-3 [&>*]:py-[7px] ${
          open
            ? 'border-accent/45 bg-accent/[0.06]'
            : 'border-edge hover:border-edge-strong hover:bg-surface-2/80'
        }`}
      >
        {pills.map((pill) => (
          <span key={pill.label} className="inline-flex items-center gap-2 whitespace-nowrap">
            <StatusMark
              kind={kindFromTone(pill.indicator.tone, pill.indicator.value)}
              label={`${pill.label}: ${pill.indicator.value}`}
            />
            <span className="text-[9.5px] tracking-[0.14em] text-text-3 uppercase">
              {pill.label}
            </span>
            <span className={`tnum text-[10.5px] font-medium ${TONE_TEXT[pill.indicator.tone]}`}>
              {pill.indicator.value}
            </span>
          </span>
        ))}
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Eta sistèm"
          className="panel panel-primary animate-rise absolute top-12 right-0 z-40 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2 p-3.5"
        >
          <p className="telemetry-label">Konpozan</p>

          {components.length === 0 ? (
            <p className="text-[12px] text-text-3">
              Pwen estati a pa reponn, kidonk pa gen anyen pou rapòte isit la. Pastiy anwo yo montre
              sa entèfas la te ka detèmine pou kont li.
            </p>
          ) : (
            <ul className="flex max-h-[320px] flex-col gap-1.5 overflow-y-auto">
              {components.map((component) => (
                <li
                  key={component.component}
                  className="flex flex-col gap-1 rounded-lg border border-edge bg-surface-2/70 px-2.5 py-2"
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-[12px] text-text-2">{label(component.component)}</span>
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className={`h-[5px] w-[5px] rounded-full ${HEALTH_DOT[component.health] ?? 'bg-text-3'}`}
                      />
                      <span
                        className={`font-mono text-[9.5px] tracking-wider uppercase ${HEALTH_TONE[component.health] ?? 'text-text-3'}`}
                      >
                        {component.health.replace(/_/g, ' ')}
                      </span>
                    </span>
                  </span>
                  <span className="text-[10.5px] leading-relaxed text-text-3">
                    {component.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <a
            href="#system-heading"
            onClick={() => setOpen(false)}
            className="rounded-lg border border-edge px-2.5 py-1.5 text-center text-[11px] text-text-2 hover:border-accent/40 hover:text-text-1"
          >
            Louvri seksyon sistèm nan
          </a>
        </div>
      ) : null}
    </div>
  );
}
