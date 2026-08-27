'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import type { Timeframe } from '@binaryai/types';
import { OFFERED_TIMEFRAMES, readTimeframe } from '@/lib/timeframe';

/**
 * Timeframe selection.
 *
 * The URL is the state. Selecting a timeframe pushes `?tf=` and the server
 * re-renders with candles for that timeframe — the control drives real data
 * rather than toggling a local highlight. It also makes a view shareable and
 * survivable across a refresh, which a `useState` would not.
 *
 * The list comes from the shared types package, so the UI cannot offer a
 * timeframe the engine does not understand. Whether the *provider* serves it is
 * a separate question, answered honestly by the canvas when no candles exist.
 */

export function TimeframeControl() {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const current = readTimeframe(params.get('tf') ?? undefined);

  const select = (option: Timeframe): void => {
    const next = new URLSearchParams(params.toString());
    next.set('tf', option);
    startTransition(() => {
      // replace, not push: changing timeframe is adjusting a view, not
      // navigating somewhere the back button should have to unwind.
      router.replace(`?${next.toString()}`, { scroll: false });
    });
  };

  return (
    <div
      role="group"
      aria-label="Chart timeframe"
      aria-busy={pending}
      className={`flex w-max items-center gap-px rounded-md border border-edge bg-surface-2 p-px transition-opacity ${
        pending ? 'opacity-60' : ''
      }`}
    >
      {OFFERED_TIMEFRAMES.map((option) => {
        const selected = option === current;
        return (
          <button
            key={option}
            type="button"
            onClick={() => select(option)}
            aria-pressed={selected}
            className={`tnum rounded-[5px] px-2.5 py-1 text-[12px] transition-colors ${
              selected
                ? 'bg-surface-3 font-medium text-text-1'
                : 'text-text-3 hover:bg-surface-3/60 hover:text-text-2'
            }`}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

/** Read-only display for the market context strip. */
export function TimeframeReadout({ timeframe }: { timeframe: Timeframe }) {
  return <span className="tnum text-[15px] leading-none font-medium text-text-1">{timeframe}</span>;
}
