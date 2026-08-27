import type {
  ApiResult,
  PaperAccountFeed,
  PaperPositionView,
  PositionsFeed,
  SimulationFeed,
} from '@/lib/api';
import { Chip, Dormant, Locked, Surface, failureHeadline } from '@/components/ui/primitives';

/**
 * Left-column account modules: the position record and the exposure ledger.
 *
 * Wider than the right rail, so these can afford a real table and a chart. Two
 * rules they hold to:
 *
 *  - **A row is never invented.** An empty table says it is empty; it does not
 *    show placeholder rows to demonstrate the layout.
 *  - **Units are never money.** The ledger visualises CAPACITY — how much of an
 *    allocation is committed — and says so beneath. There is no profit figure
 *    here because there is no payout model behind it unless the account holder
 *    configured one, and that lives in its own module.
 */

function ModuleHead({
  title,
  meta,
  badge,
  badgeTone = 'neutral',
}: {
  title: string;
  meta?: string;
  badge?: string;
  badgeTone?: 'neutral' | 'accent' | 'bull' | 'bear' | 'warn';
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-edge px-5 py-3">
      <div className="flex min-w-0 items-baseline gap-3">
        <h2 className="eyebrow text-[10px]">{title}</h2>
        {meta ? <span className="truncate text-[11px] text-text-3">{meta}</span> : null}
      </div>
      {badge ? <Chip tone={badgeTone}>{badge}</Chip> : null}
    </header>
  );
}

// ----------------------------------------------------------- positions --

const STATUS_TONE: Record<PaperPositionView['status'], string> = {
  open: 'text-accent',
  pending_settlement: 'text-warn',
  settled: 'text-text-2',
  cancelled: 'text-text-3',
  rejected: 'text-text-3',
};

const STATUS_LABEL: Record<PaperPositionView['status'], string> = {
  open: 'OPEN',
  // Not shortened to "PENDING": the distinction from OPEN is the whole point.
  pending_settlement: 'AWAITING',
  settled: 'SETTLED',
  cancelled: 'CANCELLED',
  rejected: 'REJECTED',
};

const RESULT_TONE: Record<string, string> = {
  win: 'text-bull',
  loss: 'text-bear',
  tie: 'text-text-2',
  unresolved: 'text-warn',
};

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/**
 * Signed simulated delta, with an explicit sign so a gain cannot be misread.
 * Returns null for a position that produced no simulated value at all.
 */
function simulatedDelta(
  position: PaperPositionView,
  rate: number | null,
  lossRefundRate: number,
  tieRefunds: boolean,
): number | null {
  // Only a SETTLED position with an observed result has a simulated value.
  // An open or unresolved one has none, and showing a zero would read as a
  // computed break-even rather than as nothing having happened.
  if (rate === null || position.status !== 'settled' || !position.result) return null;
  if (position.result === 'win') return position.size * rate;
  if (position.result === 'loss') return -(position.size * (1 - lossRefundRate));
  if (position.result === 'tie') return tieRefunds ? 0 : -position.size;
  return null;
}

export function RecentPositionsModule({
  feed,
  simulation,
}: {
  feed: ApiResult<PositionsFeed>;
  simulation: ApiResult<SimulationFeed>;
}) {
  if (!feed.ok) {
    return (
      <Surface className="flex flex-col">
        <ModuleHead title="Recent positions" />
        {feed.unauthorized ? (
          <Locked what="Positions are private to an account." />
        ) : (
          <div className="px-5 py-5">
            <Dormant headline={failureHeadline(feed)} detail={feed.error} />
          </div>
        )}
      </Surface>
    );
  }

  const { positions } = feed.data;

  // The model in force, used to show what each settled position was worth
  // under it. Null when simulation is off, which removes the column entirely
  // rather than filling it with dashes.
  const model =
    simulation.ok && simulation.data.simulation.enabled ? simulation.data.simulation.model : null;

  return (
    <Surface className="flex flex-col">
      <ModuleHead
        title="Recent positions"
        meta={
          model
            ? `${model.modelKey} v${model.version}`
            : positions.length > 0
              ? `${positions.length} recorded`
              : undefined
        }
        badge="simulated"
        badgeTone="warn"
      />
      <div className="flex flex-1 flex-col px-5 py-4">
        {positions.length === 0 ? (
          <Dormant
            headline="No paper positions"
            detail="Act on an accepted signal to open one. Positions appear here once your account risk policy permits the action."
          />
        ) : (
          <div className="-mx-1 overflow-x-auto">
            <table
              className={`w-full border-collapse text-[12px] ${
                model ? 'min-w-[600px]' : 'min-w-[520px]'
              }`}
            >
              <caption className="sr-only">Recent paper positions</caption>
              <thead>
                <tr className="border-b border-edge text-left">
                  {[
                    'ID',
                    'Direction',
                    'Status',
                    'Opened',
                    'Expires',
                    'Outcome',
                    'Exposure',
                    // Only when a model is in force. A column of dashes would
                    // imply figures exist that simply are not shown.
                    ...(model ? ['Simulated'] : []),
                  ].map((heading, index) => (
                    <th
                      key={heading}
                      scope="col"
                      className={`eyebrow px-1 py-2 text-[10px] font-normal ${
                        index >= 5 ? 'text-right' : ''
                      }`}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => (
                  <tr key={position.id} className="border-b border-edge/50 last:border-0">
                    <td className="px-1 py-2.5">
                      {/* A short prefix, not a fabricated broker order number. */}
                      <span className="tnum text-[11px] text-text-3">
                        {position.id.slice(0, 8)}
                      </span>
                    </td>
                    <td className="px-1 py-2.5">
                      <span
                        className={`tnum font-medium ${
                          position.direction === 'call' ? 'text-bull' : 'text-bear'
                        }`}
                      >
                        {position.direction === 'call' ? '↑ CALL' : '↓ PUT'}
                      </span>
                    </td>
                    <td className="px-1 py-2.5">
                      <span className={`tnum text-[11px] ${STATUS_TONE[position.status]}`}>
                        {STATUS_LABEL[position.status]}
                      </span>
                    </td>
                    <td className="tnum px-1 py-2.5 text-text-3">{clock(position.openedAt)}</td>
                    <td className="tnum px-1 py-2.5 text-text-3">{clock(position.expiresAt)}</td>
                    <td className="px-1 py-2.5 text-right">
                      {/* An unsettled position has no outcome. Showing one
                          would read as a settled loss. */}
                      {position.status === 'settled' && position.result ? (
                        <span className={`tnum text-[11px] ${RESULT_TONE[position.result]}`}>
                          {position.result.toUpperCase()}
                        </span>
                      ) : (
                        <span className="tnum text-[11px] text-text-3">PENDING</span>
                      )}
                    </td>
                    <td className="tnum px-1 py-2.5 text-right text-text-2">
                      {position.size} units
                    </td>
                    {model ? (
                      <td className="tnum px-1 py-2.5 text-right">
                        {(() => {
                          const delta = simulatedDelta(
                            position,
                            model.parameters.simulatedReturnRate,
                            model.parameters.lossRule === 'partial_refund'
                              ? model.parameters.lossRefundRate
                              : 0,
                            model.parameters.tieRule === 'refund_exposure',
                          );
                          if (delta === null) {
                            // Nothing settled, so nothing was computed.
                            return <span className="text-[11px] text-text-3">—</span>;
                          }
                          const tone =
                            Math.abs(delta) < 0.005
                              ? 'text-text-2'
                              : delta > 0
                                ? 'text-bull'
                                : 'text-bear';
                          const sign = Math.abs(delta) < 0.005 ? '' : delta > 0 ? '+' : '−';
                          return (
                            <span className={`text-[11px] ${tone}`}>
                              {sign}
                              {Math.abs(delta).toFixed(2)}
                            </span>
                          );
                        })()}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Surface>
  );
}

// -------------------------------------------------------------- ledger --

/**
 * Exposure capacity, drawn as a ring.
 *
 * Deliberately a capacity gauge and not a performance chart. The arc shows how
 * much of an allocation is committed right now — a fact about headroom, with no
 * bearing on whether any position was correct.
 */
function CapacityRing({ committed, allocated }: { committed: number; allocated: number }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const fraction = allocated > 0 ? Math.min(1, Math.max(0, committed / allocated)) : 0;
  const used = circumference * fraction;

  return (
    <div className="relative flex h-[92px] w-[92px] shrink-0 items-center justify-center">
      <svg viewBox="0 0 92 92" className="h-full w-full -rotate-90" aria-hidden>
        <circle
          cx="46"
          cy="46"
          r={radius}
          fill="none"
          stroke="var(--edge-strong)"
          strokeWidth="7"
        />
        {fraction > 0 ? (
          <circle
            cx="46"
            cy="46"
            r={radius}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${used} ${circumference - used}`}
          />
        ) : null}
      </svg>
      <span className="absolute flex flex-col items-center">
        <span className="tnum text-[17px] leading-none font-semibold text-text-1">
          {Math.round(fraction * 100)}%
        </span>
        <span className="text-[9px] tracking-[0.1em] text-text-3 uppercase">used</span>
      </span>
    </div>
  );
}

export function LedgerSummaryModule({ account }: { account: ApiResult<PaperAccountFeed> }) {
  if (!account.ok) {
    return (
      <Surface className="flex flex-col">
        <ModuleHead title="Ledger summary" />
        {account.unauthorized ? (
          <Locked what="The ledger is per account." />
        ) : (
          <div className="px-5 py-5">
            <Dormant headline={failureHeadline(account)} detail={account.error} />
          </div>
        )}
      </Surface>
    );
  }

  const { paper } = account.data;
  const configured = paper.accountingModel === 'exposure_only';

  return (
    <Surface className="flex flex-col">
      <ModuleHead title="Ledger summary" meta="append-only" />
      <div className="flex flex-1 flex-col gap-4 px-5 py-4">
        {!configured ? (
          <Dormant
            headline="Accounting model not configured"
            detail="This account has no unit allocation, so there is no capacity to report."
          />
        ) : (
          <div className="flex items-center gap-5">
            <CapacityRing committed={paper.committedUnits} allocated={paper.allocatedUnits} />
            <dl className="flex min-w-0 flex-1 flex-col gap-2.5">
              {[
                ['Allocated', paper.allocatedUnits],
                ['Committed', paper.committedUnits],
                ['Available', paper.availableUnits],
              ].map(([label, value]) => (
                <div key={String(label)} className="flex items-baseline justify-between gap-3">
                  <dt className="text-[12px] text-text-3">{label}</dt>
                  <dd className="tnum text-[13px] font-medium text-text-1">{value} units</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {/* The sentence that keeps the ring from reading as performance. */}
        <p className="border-t border-edge pt-3 text-[11px] leading-relaxed text-text-3">
          Exposure model — not monetary profit and loss. {paper.accountingNote}
        </p>
      </div>
    </Surface>
  );
}
