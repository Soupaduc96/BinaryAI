import type { ApiResult, PaperPositionView, SignalFeed } from '@/lib/api';
import { Chip, Dormant, Locked, ModuleHeader, Surface } from '@/components/ui/primitives';

/**
 * The signal record, and what was done about each one.
 *
 * The columns deliberately span the whole pipeline — signal, risk, action,
 * position, outcome — because the relationship between them is the thing a user
 * needs and the thing that is hardest to reconstruct from separate panels.
 *
 * Two rules the table holds to:
 *
 *  - **A missing value is "—", never zero.** A signal with no paper action has
 *    no position state; rendering that as OPEN or as 0 would be a claim.
 *  - **State comes from the record, never inferred.** A position's status is
 *    read from the position; an absent position means no action was taken, and
 *    the table says exactly that.
 */

const DIRECTION_TONE: Record<string, 'bull' | 'bear' | 'neutral'> = {
  call: 'bull',
  put: 'bear',
  none: 'neutral',
};

/** Where a signal reached in the pipeline. */
type PipelineState =
  'no_signal' | 'risk_blocked' | 'available' | 'action_taken' | 'active' | 'settled' | 'unresolved';

const STATE_LABEL: Record<PipelineState, string> = {
  no_signal: 'NO SIGNAL',
  risk_blocked: 'RISK BLOCKED',
  available: 'AVAILABLE',
  action_taken: 'ACTION TAKEN',
  active: 'ACTIVE',
  settled: 'SETTLED',
  unresolved: 'UNRESOLVED',
};

const RESULT_TONE: Record<string, string> = {
  win: 'text-bull',
  loss: 'text-bear',
  tie: 'text-text-2',
  unresolved: 'text-warn',
};

const STATE_TONE: Record<PipelineState, string> = {
  no_signal: 'text-text-3',
  risk_blocked: 'text-bear',
  available: 'text-accent',
  action_taken: 'text-accent',
  active: 'text-accent',
  settled: 'text-text-2',
  unresolved: 'text-warn',
};

/**
 * The state of one signal, from the records that exist.
 *
 * Never guesses: with no position, the furthest this can say is whether the
 * engine accepted the signal. Whether RISK would permit an action is an
 * account-level question this table does not ask, so it is not asserted here.
 */
export function pipelineState(
  signal: { status: string; direction: string },
  position: PaperPositionView | undefined,
): PipelineState {
  if (position) {
    if (position.status === 'settled') return 'settled';
    if (position.status === 'pending_settlement') return 'unresolved';
    if (position.status === 'open') return 'active';
    return 'action_taken';
  }
  if (signal.direction === 'none' || signal.status !== 'accepted') return 'risk_blocked';
  return 'available';
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/** Absent, not zero. */
function Dash() {
  return <span className="text-text-3">—</span>;
}

export function SignalIntelligence({
  feed,
  positions,
}: {
  feed: ApiResult<SignalFeed>;
  /** Positions, so a signal can be related to the action taken on it. */
  positions?: ApiResult<{ positions: readonly PaperPositionView[] }>;
}) {
  if (!feed.ok) {
    return (
      <Surface aria-labelledby="signals-heading" className="flex flex-col">
        <ModuleHeader label="Signal Intelligence" id="signals-heading" />
        {feed.unauthorized ? (
          <Locked what="Your own signals are private; the shared stream needs a session." />
        ) : (
          <div className="px-5 py-6">
            <Dormant headline="Feed unavailable" detail={feed.error} />
          </div>
        )}
      </Surface>
    );
  }

  const { signals, total } = feed.data;

  if (signals.length === 0) {
    return (
      <Surface aria-labelledby="signals-heading" className="flex flex-col">
        <ModuleHeader label="Signal Intelligence" id="signals-heading" meta="0 recorded" />
        <div className="px-5 py-6">
          <Dormant
            headline="No validated signals"
            detail="BinaryAI will surface signals here once market data has been validated and a decision recorded."
            hint="Feed columns: time · instrument · direction · confidence · risk · state · action"
          />
        </div>
      </Surface>
    );
  }

  // Positions keyed by the signal they were opened on, so each row reports the
  // real action rather than an assumed one.
  const bySignal = new Map<string, PaperPositionView>();
  if (positions?.ok) {
    for (const position of positions.data.positions) bySignal.set(position.signalId, position);
  }

  return (
    <Surface aria-labelledby="signals-heading" className="flex flex-col">
      <ModuleHeader label="Signal Intelligence" id="signals-heading" meta={`${total} recorded`} />

      {/* Cards below lg. Same data, same states, no sideways scroll. */}
      <ul className="flex flex-col divide-y divide-edge/70 lg:hidden">
        {signals.map((signal) => {
          const position = bySignal.get(signal.id);
          const state = pipelineState(signal, position);
          return (
            <li key={signal.id} className="flex flex-col gap-2.5 px-5 py-3.5">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2.5">
                  <Chip tone={DIRECTION_TONE[signal.direction] ?? 'neutral'}>
                    {signal.direction}
                  </Chip>
                  <span className="truncate text-[13px] text-text-1">{signal.assetSymbol}</span>
                  <span className="tnum text-[11px] text-text-3">{signal.timeframe}</span>
                </span>
                <span className={`text-[10.5px] font-medium ${STATE_TONE[state]}`}>
                  {STATE_LABEL[state]}
                </span>
              </div>
              <dl className="grid grid-cols-3 gap-3">
                {[
                  ['Time', <span className="tnum">{formatTime(signal.decidedAt)}</span>],
                  [
                    'Confidence',
                    <span className="tnum">{Math.round(signal.confidence * 100)}%</span>,
                  ],
                  [
                    'Outcome',
                    position?.status === 'settled' && position.result ? (
                      <span className={RESULT_TONE[position.result] ?? 'text-text-2'}>
                        {position.result.toUpperCase()}
                      </span>
                    ) : (
                      <Dash />
                    ),
                  ],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex min-w-0 flex-col gap-1">
                    <dt className="telemetry-label">{label}</dt>
                    <dd className="truncate text-[12px] text-text-2">{value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>

      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[38rem] border-collapse">
          <caption className="sr-only">
            Recorded signals with the paper action and outcome for each, newest first
          </caption>
          <thead>
            <tr>
              {['Time', 'Instrument', 'Direction', 'Confidence', 'Risk', 'State', 'Outcome'].map(
                (heading, index) => (
                  <th
                    key={heading}
                    scope="col"
                    className={`eyebrow px-3 pt-3 pb-2 font-semibold ${index > 2 ? 'text-right' : 'text-left'}`}
                  >
                    {heading}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {signals.map((signal) => {
              const position = bySignal.get(signal.id);
              const state = pipelineState(signal, position);
              return (
                <tr key={signal.id} className="border-t border-edge/70 hover:bg-surface-2">
                  <td className="tnum px-3 py-2.5 text-[12px] text-text-3">
                    {formatTime(signal.decidedAt)}
                  </td>
                  <td className="px-3 py-2.5 text-[13px] text-text-1">
                    {signal.assetSymbol}
                    <span className="tnum ml-2 text-[11px] text-text-3">{signal.timeframe}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <Chip tone={DIRECTION_TONE[signal.direction] ?? 'neutral'}>
                      {signal.direction}
                    </Chip>
                  </td>
                  <td className="tnum px-3 py-2.5 text-right text-[13px] text-text-1">
                    {Math.round(signal.confidence * 100)}%
                  </td>
                  <td className="px-3 py-2.5 text-right text-[12px] text-text-2">
                    {signal.riskLevel}
                  </td>
                  <td className={`px-3 py-2.5 text-right text-[11px] ${STATE_TONE[state]}`}>
                    {STATE_LABEL[state]}
                  </td>
                  <td className="px-3 py-2.5 text-right text-[11px]">
                    {position?.status === 'settled' && position.result ? (
                      <span className={RESULT_TONE[position.result] ?? 'text-text-2'}>
                        {position.result.toUpperCase()}
                      </span>
                    ) : (
                      // No settled position means no outcome exists. Not zero,
                      // not pending-as-a-result: simply absent.
                      <Dash />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Surface>
  );
}
