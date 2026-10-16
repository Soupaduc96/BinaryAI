'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import type { AssetClassStatus, CapabilityState, InstrumentStatus } from '@binaryai/types';
import { apiBaseUrl } from '@/lib/api-base';

/**
 * The instrument picker.
 *
 * Replaces a bare `<select>` over whatever happened to be stored. The shape is
 * a command palette rather than a dropdown, because the task is "find an
 * instrument among thirty-six across five asset classes", and a native select
 * cannot group, search, or say why a row is unusable.
 *
 * THE SERVER IS AUTHORITATIVE. Every row here came from `/v1/instruments`. This
 * component filters and renders; it never constructs an instrument, and it
 * never learns a provider's symbol syntax.
 *
 * WHAT IT REFUSES TO DO: hide an unavailable instrument. A forex pair in a
 * deployment with no forex provider is shown, greyed, labelled NOT CONFIGURED,
 * and not selectable. Hiding it would answer "does BinaryAI support forex?"
 * with silence, and silence reads as "no".
 */

const CLASS_ORDER = ['crypto', 'forex', 'stock', 'index', 'commodity'] as const;

/**
 * Capability states, rendered.
 *
 * Five distinct labels, not one "Unavailable". The user's next action differs
 * for each: configure a provider, choose another timeframe, run an ingestion,
 * investigate an outage, or simply wait.
 */
const STATE: Record<CapabilityState, { label: string; dot: string; text: string }> = {
  available: { label: 'Available', dot: 'bg-bull', text: 'text-bull' },
  not_configured: { label: 'Not configured', dot: 'bg-text-3', text: 'text-text-3' },
  unsupported: { label: 'Unsupported', dot: 'bg-text-3', text: 'text-text-3' },
  no_data: { label: 'No data', dot: 'bg-warn', text: 'text-warn' },
  provider_error: { label: 'Provider error', dot: 'bg-bear', text: 'text-bear' },
  rate_limited: { label: 'Rate limited', dot: 'bg-warn', text: 'text-warn' },
};

/** Enough history for the chart and every offered indicator's warm-up. */
const INGEST_BARS = 300;

const TIMEFRAME_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86_400,
};

export function InstrumentPicker({
  instruments,
  assetClasses,
  current,
  timeframe,
}: {
  instruments: readonly InstrumentStatus[];
  assetClasses: readonly AssetClassStatus[];
  current: InstrumentStatus | null;
  timeframe: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeClass, setActiveClass] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus the field on open: the picker is a search surface, and a palette that
  // needs a second click to type into is a palette people stop using.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Escape closes; a click outside closes. Both are expected of a palette, and
  // their absence is the thing that makes a custom control feel broken.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const select = useCallback(
    (symbol: string): void => {
      const next = new URLSearchParams(params.toString());
      next.set('asset', symbol);
      setOpen(false);
      setQuery('');
      startTransition(() => router.replace(`?${next.toString()}`, { scroll: false }));
    },
    [params, router],
  );

  /**
   * Ingests a recent window, then selects.
   *
   * BinaryAI charts stored, validated bars — never a provider passthrough — so
   * an instrument with no stored candles has nothing to draw until this runs.
   * A bounded window, because "fetch everything" is not a path the API offers
   * and inventing a long backfill here would burn the provider's quota.
   */
  async function addAndSelect(entry: InstrumentStatus): Promise<void> {
    const symbol = entry.instrument.symbol;
    setBusy(symbol);
    setMessage(null);
    try {
      const to = Date.now();
      const seconds = TIMEFRAME_SECONDS[timeframe] ?? 60;
      const from = to - seconds * 1000 * INGEST_BARS;

      const response = await fetch(`${apiBaseUrl}/v1/market-data/ingest`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ asset: symbol, timeframe, from, to, maxCandles: INGEST_BARS }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        // The API's own message names the cause — unknown instrument, no
        // provider for the class, unsupported timeframe. Replacing it with
        // "failed" would discard the only actionable part.
        setMessage(body?.error?.message ?? `Ingestion was refused (${response.status}).`);
        return;
      }

      select(symbol);
      startTransition(() => router.refresh());
    } catch {
      setMessage(`Could not reach the API at ${apiBaseUrl}.`);
    } finally {
      setBusy(null);
    }
  }

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = instruments.filter((entry) => {
      if (activeClass !== null && entry.instrument.assetClass !== activeClass) return false;
      if (needle === '') return true;
      const { symbol, displaySymbol, name, quoting } = entry.instrument;
      return (
        symbol.toLowerCase().includes(needle) ||
        displaySymbol.toLowerCase().includes(needle) ||
        name.toLowerCase().includes(needle) ||
        (quoting.base ?? '').toLowerCase() === needle ||
        quoting.quote.toLowerCase() === needle
      );
    });

    return CLASS_ORDER.map((assetClass) => ({
      assetClass,
      status: assetClasses.find((entry) => entry.assetClass === assetClass) ?? null,
      entries: matches.filter((entry) => entry.instrument.assetClass === assetClass),
    })).filter((group) => group.entries.length > 0);
  }, [instruments, assetClasses, query, activeClass]);

  const label = current?.instrument.displaySymbol ?? 'Select instrument';
  const classLabel = current
    ? (assetClasses.find((entry) => entry.assetClass === current.instrument.assetClass)?.label ??
      current.instrument.assetClass)
    : null;

  return (
    <div ref={panelRef} className={`relative ${pending ? 'opacity-70' : ''}`}>
      {/*
        The trigger reads as an instrument readout that happens to be
        actionable, not as a form control: the symbol is the loudest thing in
        it, with the asset class as a quiet qualifier above.
      */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="group flex min-w-[210px] items-center gap-3 rounded-[8px] border border-edge-strong bg-surface-2 px-3 py-2 text-left transition-colors hover:border-accent/40"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="telemetry-label">{classLabel ?? 'Instrument'}</span>
          <span className="tnum truncate text-[15px] leading-none font-medium tracking-[-0.01em] text-text-1">
            {label}
          </span>
        </span>
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5 shrink-0 text-text-3 transition-colors group-hover:text-text-2"
        >
          <path
            d="M4 6.5 8 10.5 12 6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Chwazi yon enstriman"
          /*
            Fixed-position on a phone so the palette is a full-width sheet
            rather than a 320px panel escaping a 390px viewport; absolute from
            `sm` up, where it belongs beside its trigger.
          */
          className="fixed inset-x-3 top-[64px] z-40 flex max-h-[min(560px,calc(100vh-96px))] flex-col overflow-hidden rounded-[10px] border border-edge-strong bg-surface-1 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.9)] sm:absolute sm:inset-x-auto sm:top-[calc(100%+6px)] sm:left-0 sm:w-[420px]"
        >
          <div className="border-b border-edge p-2.5">
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search BTC, EUR, AAPL, Gold…"
              aria-label="Chèche enstriman"
              className="h-9 w-full rounded-[7px] border border-edge-strong bg-surface-2 px-3 text-[13px] text-text-1 placeholder:text-text-3 focus:border-accent/50 focus:outline-none"
            />

            {/* Class filters. "All" first, so the default is the whole
                catalogue rather than an arbitrary class. */}
            <div className="mt-2 flex gap-1 overflow-x-auto pb-0.5">
              <ClassChip
                label="Tout"
                active={activeClass === null}
                onClick={() => setActiveClass(null)}
              />
              {CLASS_ORDER.map((assetClass) => {
                const status = assetClasses.find((entry) => entry.assetClass === assetClass);
                return (
                  <ClassChip
                    key={assetClass}
                    label={status?.label ?? assetClass}
                    active={activeClass === assetClass}
                    muted={status?.state !== 'available'}
                    onClick={() => setActiveClass(assetClass)}
                  />
                );
              })}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {grouped.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12.5px] text-text-3">
                Nothing in the catalogue matches “{query}”.
              </p>
            ) : (
              grouped.map((group) => (
                <section key={group.assetClass}>
                  {/*
                    The group header carries the CLASS-level verdict. This is
                    where "FOREX — Not configured" lives: one line answering
                    "can BinaryAI get this kind of data at all", above rows that
                    would otherwise look individually broken.
                  */}
                  <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-edge bg-surface-1/95 px-3 py-1.5 backdrop-blur">
                    <span className="eyebrow">{group.status?.label ?? group.assetClass}</span>
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className={`h-[5px] w-[5px] rounded-full ${STATE[group.status?.state ?? 'not_configured'].dot}`}
                      />
                      <span
                        className={`text-[10px] tracking-[0.06em] uppercase ${STATE[group.status?.state ?? 'not_configured'].text}`}
                      >
                        {group.status?.state === 'available'
                          ? (group.status.providerName ?? 'Available')
                          : STATE[group.status?.state ?? 'not_configured'].label}
                      </span>
                    </span>
                  </header>

                  <ul>
                    {group.entries.map((entry) => (
                      <InstrumentRow
                        key={entry.instrument.symbol}
                        entry={entry}
                        selected={entry.instrument.symbol === current?.instrument.symbol}
                        busy={busy === entry.instrument.symbol}
                        disabled={busy !== null}
                        onSelect={() =>
                          entry.availability.chart.state === 'available'
                            ? select(entry.instrument.symbol)
                            : void addAndSelect(entry)
                        }
                      />
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>

          {message ? (
            <p role="status" className="border-t border-edge px-3 py-2 text-[11.5px] text-bear">
              {message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ClassChip({
  label,
  active,
  muted = false,
  onClick,
}: {
  label: string;
  active: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 rounded-[5px] border px-2.5 py-1 text-[11px] whitespace-nowrap transition-colors ${
        active
          ? 'border-accent/40 bg-accent/10 text-text-1'
          : muted
            ? 'border-edge text-text-3 hover:border-edge-strong'
            : 'border-edge text-text-2 hover:border-edge-strong hover:text-text-1'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * One instrument row.
 *
 * Three columns of decreasing loudness — symbol, name, state — so the eye scans
 * the left edge and only reads rightward when something is wrong. The state
 * column is the honest part: it distinguishes "ready", "will ingest on select",
 * and "cannot" instead of rendering every row identically and failing later.
 */
function InstrumentRow({
  entry,
  selected,
  busy,
  disabled,
  onSelect,
}: {
  entry: InstrumentStatus;
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { instrument, availability } = entry;
  const usable = availability.marketData.state === 'available';
  const ready = availability.chart.state === 'available';

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={!usable || disabled}
        title={usable ? availability.chart.detail : availability.marketData.detail}
        className={`flex w-full items-center gap-3 border-b border-edge/60 px-3 py-2 text-left transition-colors ${
          selected ? 'bg-accent/[0.07]' : 'hover:bg-surface-2/70'
        } disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent`}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="tnum truncate text-[13px] leading-none font-medium text-text-1">
            {instrument.displaySymbol}
          </span>
          <span className="truncate text-[11px] leading-none text-text-3">{instrument.name}</span>
        </span>

        <span className="shrink-0 text-right text-[10px] tracking-[0.06em] uppercase">
          {busy ? (
            <span className="text-accent">Ingesting…</span>
          ) : !usable ? (
            <span className={STATE[availability.marketData.state].text}>
              {STATE[availability.marketData.state].label}
            </span>
          ) : ready ? (
            <span className="text-text-3">
              {/* What is genuinely stored, not what could be. */}
              {entry.storedTimeframes.join(' · ')}
            </span>
          ) : (
            <span className="text-accent/80">Add</span>
          )}
        </span>
      </button>
    </li>
  );
}
