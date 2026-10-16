import type { FeedScope } from '@/lib/api';

/**
 * States WHICH rows a positions or ledger module is showing.
 *
 * R10. Account-wide and instrument-scoped feeds render identically — the same
 * table, the same columns, fewer rows — so the difference between "you have no
 * open positions" and "you have no open positions ON EUR/USD" is invisible
 * unless it is written down. This writes it down.
 *
 * The scope comes from the API response, never from what the client asked for.
 * A request can be ignored, coerced, or answered from a cache; only the
 * response knows what was actually returned.
 */
export function scopeLabel(feed: FeedScope, displayName?: string | null): string {
  if (feed.scope === 'account') return 'Account-wide · all instruments';
  return `${displayName ?? feed.assetSymbol ?? 'One instrument'} only`;
}

export function ScopeNote({
  feed,
  displayName,
  noun,
}: {
  feed: FeedScope;
  displayName?: string | null;
  noun: string;
}) {
  const scoped = feed.scope === 'instrument';
  return (
    <p className="text-[11px] leading-relaxed text-text-3">
      <span className={scoped ? 'text-text-2' : undefined}>{scopeLabel(feed, displayName)}</span>
      {scoped
        ? ` — ${noun} on other instruments are not shown here.`
        : ` — every instrument this account holds ${noun} on.`}
    </p>
  );
}
