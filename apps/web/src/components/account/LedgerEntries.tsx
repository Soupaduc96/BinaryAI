import { ScopeNote } from '@/components/account/ScopeNote';
import type { ApiResult, LedgerEntry, LedgerFeed } from '@/lib/api';
import {
  Chip,
  Dormant,
  Locked,
  ModuleHeader,
  Surface,
  failureHeadline,
} from '@/components/ui/primitives';

/**
 * The ledger itself.
 *
 * `GET /v1/accounts/:id/ledger` has existed since Phase 5 and nothing had ever
 * called it — the dashboard only showed totals derived from the account, so the
 * append-only record the whole accounting model rests on was invisible.
 *
 * Two things this must not do:
 *
 *  - **Never call a `simulated_return` a profit.** It is a figure produced by a
 *    named, versioned model under stated assumptions. The model is shown on the
 *    row, because the same outcome under a different model is a different
 *    number and a figure without its model is not interpretable.
 *  - **Never net exposure against simulation.** Committing exposure and
 *    releasing it are capacity accounting; a simulated return is a separate
 *    entry type. Summing them into one "balance" would invent a P&L.
 */

const TYPE_LABEL: Record<string, string> = {
  initial_allocation: 'Initial allocation',
  exposure_committed: 'Exposure committed',
  exposure_released: 'Exposure released',
  simulated_return: 'Simulated return',
  adjustment: 'Adjustment',
  reset: 'Reset',
};

function when(value: number): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 19);
}

function amount(value: number): string {
  const fixed = Math.abs(value) < 0.005 ? value.toFixed(2) : value.toFixed(2);
  return value > 0 ? `+${fixed}` : fixed;
}

function tone(entry: LedgerEntry): string {
  if (entry.type === 'simulated_return') return entry.amount >= 0 ? 'text-bull' : 'text-bear';
  return 'text-text-2';
}

export function LedgerEntriesModule({ feed }: { feed: ApiResult<LedgerFeed> }) {
  if (!feed.ok) {
    return (
      <Surface aria-labelledby="ledger-entries-heading" className="flex flex-col">
        <ModuleHeader label="Antre rejis" id="ledger-entries-heading" />
        {feed.unauthorized ? (
          <Locked what="Rejis la prive pou yon kont." />
        ) : (
          <div className="px-5 py-5">
            <Dormant headline={failureHeadline(feed)} detail={feed.error} />
          </div>
        )}
      </Surface>
    );
  }

  const entries = feed.data.entries;

  if (entries.length === 0) {
    return (
      <Surface aria-labelledby="ledger-entries-heading" className="flex flex-col">
        <ModuleHeader label="Antre rejis" id="ledger-entries-heading" />
        <div className="px-5 py-5">
          <Dormant
            headline="Poko gen antre"
            detail={
              feed.data.reason ??
              'The ledger records an entry when units are allocated, committed to a position, released, or valued by a simulation model.'
            }
          />
          {/* Shown on the empty state too: "no entries" and "no entries on
              this instrument" are different facts, and the second one is the
              easier of the two to misread. */}
          <div className="mt-3">
            <ScopeNote feed={feed.data} noun="entries" />
          </div>
        </div>
      </Surface>
    );
  }

  const simulated = entries.filter((entry) => entry.type === 'simulated_return').length;

  return (
    <Surface aria-labelledby="ledger-entries-heading" className="flex flex-col">
      <ModuleHeader
        label="Antre rejis"
        id="ledger-entries-heading"
        meta={`${entries.length} shown`}
        action={<Chip tone="neutral">append-only</Chip>}
      />

      <div className="border-b border-edge px-4 py-2">
        <ScopeNote feed={feed.data} noun="entries" />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-edge text-left">
              <th className="telemetry-label px-4 py-2 font-normal">Occurred</th>
              <th className="telemetry-label px-4 py-2 font-normal">Entry</th>
              <th className="telemetry-label px-4 py-2 text-right font-normal">Units</th>
              <th className="telemetry-label px-4 py-2 font-normal">Model</th>
              <th className="telemetry-label px-4 py-2 font-normal">Source</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-b border-edge/60 last:border-0">
                <td className="tnum px-4 py-2 whitespace-nowrap text-text-3">
                  {when(entry.occurredAt)}
                </td>
                <td className="px-4 py-2 text-text-2">
                  {TYPE_LABEL[entry.type] ?? entry.type.replace(/_/g, ' ')}
                </td>
                <td className={`tnum px-4 py-2 text-right font-medium ${tone(entry)}`}>
                  {amount(entry.amount)}
                </td>
                <td className="px-4 py-2 text-text-3">
                  {entry.simulationModelVersion ? (
                    <span className="tnum">
                      {String(entry.metadata['modelKey'] ?? 'model')} v
                      {entry.simulationModelVersion}
                    </span>
                  ) : (
                    // Exposure entries have no model, and a dash says so rather
                    // than borrowing the account's current one.
                    <span className="text-text-3/60">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-text-3">{entry.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-edge px-4 py-2.5">
        <Chip tone="neutral">exposure ≠ simulation</Chip>
        {simulated > 0 ? <Chip tone="warn">{simulated} simulated</Chip> : null}
      </div>

      <p className="border-t border-edge px-4 py-3 text-[10.5px] leading-relaxed text-text-3">
        Entries are never updated or deleted; the database refuses both. Exposure entries account
        for capacity — committing units when a position opens and releasing them when it settles. A
        simulated return is a separate entry computed by the named model above, under its stated
        assumptions. It is not profit, not money, and no order was placed.
      </p>
    </Surface>
  );
}
