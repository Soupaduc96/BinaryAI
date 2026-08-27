import type { PaperPositionView } from '@/lib/api';
import { Headline, Line, Shell, clock, units } from './PaperActionParts';

/**
 * A paper position, reported.
 *
 * Split from the action panel because reporting a position and offering an
 * action are different jobs with different rules. This view never invites an
 * action, and it never shows a simulated figure before the position settles or
 * without naming the model and version that produced it.
 */

/**
 * The lifecycle a position has travelled.
 *
 * A row of stages with hairline connectors — deliberately not a progress bar.
 * A progress bar implies advancement toward something desirable; this is a
 * record of where a position actually is, and the final stage is as likely to
 * read LOSS as WIN.
 *
 * The last stage is only ever labelled from the RECORDED outcome. An open
 * position shows it as pending, never as a projected result.
 */
function Lifecycle({ position }: { position: PaperPositionView }) {
  const settled = position.status === 'settled';
  const unresolved = position.status === 'pending_settlement';

  // Every position reaching this component has a signal and an action behind
  // it, so those two stages are complete by definition.
  const stages: { label: string; done: boolean; tone?: string }[] = [
    { label: 'Signal', done: true },
    { label: 'Action', done: true },
    { label: 'Open', done: true },
    {
      label: unresolved ? 'Unresolved' : 'Settled',
      done: settled || unresolved,
      ...(unresolved ? { tone: 'text-warn' } : {}),
    },
    {
      label: settled && position.result ? position.result.toUpperCase() : 'Outcome',
      done: settled && position.result !== null,
      ...(settled && position.result
        ? {
            tone:
              position.result === 'win'
                ? 'text-bull'
                : position.result === 'loss'
                  ? 'text-bear'
                  : 'text-text-2',
          }
        : {}),
    },
  ];

  return (
    <ol className="flex items-center gap-1.5" aria-label="Position lifecycle">
      {stages.map((stage, index) => (
        <li key={stage.label} className="flex min-w-0 items-center gap-1.5">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`h-[5px] w-[5px] shrink-0 rounded-full ${
                stage.done
                  ? stage.tone
                    ? stage.tone.replace('text-', 'bg-')
                    : 'bg-accent'
                  : 'bg-edge-strong'
              }`}
            />
            <span
              className={`truncate text-[10px] tracking-[0.1em] uppercase ${
                stage.done ? (stage.tone ?? 'text-text-2') : 'text-text-3'
              }`}
            >
              {stage.label}
            </span>
          </span>
          {index < stages.length - 1 ? (
            <span
              aria-hidden
              className={`h-px w-3 shrink-0 ${stages[index + 1]?.done ? 'bg-edge-strong' : 'bg-edge'}`}
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** §9/§11: the panel once a position exists on this signal. */
export function PositionState({ position }: { position: PaperPositionView }) {
  const settled = position.status === 'settled';
  const unresolved = position.status === 'pending_settlement';

  return (
    <Shell>
      <Headline tone={settled ? 'neutral' : 'accent'}>
        {settled
          ? 'Paper position settled'
          : unresolved
            ? 'Awaiting settlement'
            : 'Paper position active'}
      </Headline>

      <div className="-mt-0.5 overflow-x-auto pb-0.5">
        <Lifecycle position={position} />
      </div>

      <dl className="flex flex-col divide-y divide-edge/70 rounded-[6px] border border-edge bg-surface-2">
        <Line label="Position" value={<span className="tnum">{position.id.slice(0, 8)}</span>} />
        <Line
          label="Direction"
          value={
            <span className={position.direction === 'call' ? 'text-bull' : 'text-bear'}>
              PAPER {position.direction.toUpperCase()}
            </span>
          }
        />
        <Line label="Exposure" value={`${units(position.size)} units`} />
        <Line label="Opened" value={<span className="tnum">{clock(position.openedAt)}</span>} />
        <Line label="Expires" value={<span className="tnum">{clock(position.expiresAt)}</span>} />
        <Line
          label="Status"
          value={
            settled ? (
              'SETTLED'
            ) : unresolved ? (
              <span className="text-warn">UNRESOLVED</span>
            ) : (
              <span className="text-accent">OPEN</span>
            )
          }
        />
        {settled ? (
          <>
            <Line
              label="Outcome"
              value={
                position.result ? (
                  <span
                    className={
                      position.result === 'win'
                        ? 'text-bull'
                        : position.result === 'loss'
                          ? 'text-bear'
                          : 'text-text-2'
                    }
                  >
                    {position.result.toUpperCase()}
                  </span>
                ) : (
                  <span className="text-text-3">—</span>
                )
              }
            />
            <Line
              label="Settled"
              value={
                position.settledAt === null ? (
                  <span className="text-text-3">—</span>
                ) : (
                  <span className="tnum">{clock(position.settledAt)}</span>
                )
              }
            />
            <Line
              label="Settling bar"
              value={
                position.settlementCandleAt === null ? (
                  <span className="text-text-3">—</span>
                ) : (
                  <span className="tnum">{clock(position.settlementCandleAt)}</span>
                )
              }
            />
            <Line
              label="Reference price"
              value={
                position.settlementPrice === null ? (
                  // Genuinely absent, not zero.
                  <span className="text-text-3">—</span>
                ) : (
                  <span className="tnum">{position.settlementPrice.toFixed(5)}</span>
                )
              }
            />
          </>
        ) : null}
      </dl>

      {/* A simulated figure NEVER appears without the model and version that
          produced it, and never before the position has settled. */}
      {settled && position.simulation ? (
        <div className="flex flex-col gap-1.5 rounded-[6px] border border-edge bg-surface-2 px-3 py-2.5">
          <span className="eyebrow text-[10px]">Simulated return</span>
          <span
            className={`tnum text-[20px] leading-none font-semibold ${
              position.simulation.delta > 0
                ? 'text-bull'
                : position.simulation.delta < 0
                  ? 'text-bear'
                  : 'text-text-1'
            }`}
          >
            {position.simulation.delta > 0 ? '+' : position.simulation.delta < 0 ? '−' : ''}
            {Math.abs(position.simulation.delta).toFixed(2)}
          </span>
          <span className="text-[11px] text-text-3">
            {position.simulation.modelName}{' '}
            <span className="tnum">v{position.simulation.modelVersion}</span>
          </span>
        </div>
      ) : settled ? (
        <p className="text-[11px] leading-relaxed text-text-3">
          No simulation model produced a figure for this position.
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-text-3">
          {/* Showing a figure before settlement would present an expectation as
              a result. */}
          No simulated return exists until this position settles.
        </p>
      )}
    </Shell>
  );
}
