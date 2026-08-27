'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiBaseUrl } from '@/lib/api-base';
import type { PaperPositionView, SimulationModelView } from '@/lib/api';
import type { RiskDecisionView } from '@/lib/api-risk';
import { PositionState } from './PositionState';
import { Headline, Line, OUTCOME_COPY, Refusal, Shell, messageOf, units } from './PaperActionParts';

/**
 * The step between a signal and a paper position.
 *
 * This is the only place in BinaryAI where a user causes something to be
 * recorded, so it is written to make the consequences legible rather than easy:
 *
 *  - **A signal is not an order.** The action is always qualified as PAPER, and
 *    the words buy, sell, execute and place never appear.
 *  - **Nothing is written without a summary first.** Confirming shows the exact
 *    exposure before and after, the risk verdict, and the model that will value
 *    the outcome.
 *  - **The button is not the control.** It is disabled while a refusal stands,
 *    but the backend refuses independently — a user who re-enables it in
 *    devtools gets a 422, not a position.
 *  - **No celebration.** Opening a position produces a row and a confirmation
 *    line. There is nothing here to congratulate.
 *
 * The panel is visually subordinate to the decision above it by design: the
 * intelligence is the protagonist, and the action is a consequence of reading
 * it rather than the reason the screen exists.
 */

export interface ActionCapacity {
  readonly availableUnits: number;
  readonly committedUnits: number;
  readonly openPositions: number;
  readonly maxOpenPositions: number;
  readonly maxPositionSize: number;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'confirming' }
  | { kind: 'opened'; positionId: string; duplicate: boolean }
  | { kind: 'refused'; decision: RiskDecisionView }
  | { kind: 'error'; message: string };

export function PaperActionPanel({
  signalId,
  signedIn,
  actionable,
  direction,
  instrument,
  timeframe,
  expirySeconds,
  capacity,
  model,
  actionability,
  position,
}: {
  signalId: string | null;
  signedIn: boolean;
  /** False when the engine did not accept the signal in the first place. */
  actionable: boolean;
  direction: 'call' | 'put' | null;
  instrument: string | null;
  timeframe: string | null;
  expirySeconds: number | null;
  /** Null when the account could not be read. */
  capacity: ActionCapacity | null;
  /** The model that will value the outcome, or null when simulation is off. */
  model: SimulationModelView | null;
  /**
   * The risk engine's verdict on whether this account may act on this signal at
   * all, evaluated server-side. Null when it could not be obtained.
   */
  actionability: RiskDecisionView | null;
  /** An existing paper position on this signal, if one was already opened. */
  position: PaperPositionView | null;
}) {
  const router = useRouter();
  const [size, setSize] = useState('5');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const numericSize = Number(size);
  const sizeUsable = Number.isFinite(numericSize) && numericSize > 0;

  async function act() {
    if (!signalId || !sizeUsable) return;
    setPhase({ kind: 'working' });
    try {
      const response = await fetch(`${apiBaseUrl}/v1/accounts/me/positions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Required: the session lives in an httpOnly cookie.
        credentials: 'include',
        body: JSON.stringify({
          signalId,
          size: numericSize,
          // A fresh key per attempt. A RETRY of the same attempt reuses it and
          // returns the same position rather than opening a second one.
          actionKey: crypto.randomUUID(),
        }),
      });
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;

      if (response.status === 201 || response.status === 200) {
        const opened = payload?.['position'] as { id: string } | undefined;
        setPhase({
          kind: 'opened',
          positionId: opened?.id ?? '',
          duplicate: payload?.['duplicate'] === true,
        });
        // Re-render the server components so the account, ledger, position list
        // and this panel's own position-aware state reflect what just happened.
        router.refresh();
        return;
      }

      const decision = payload?.['decision'] as RiskDecisionView | undefined;
      if (decision) {
        setPhase({ kind: 'refused', decision });
        return;
      }
      setPhase({ kind: 'error', message: messageOf(payload, 'The action was refused.') });
    } catch {
      setPhase({ kind: 'error', message: `Could not reach the API at ${apiBaseUrl}.` });
    }
  }

  // ---------------------------------------------------- preclusive states --

  if (!signalId || !actionable) {
    return (
      <Shell>
        <Headline>No paper action</Headline>
        <p className="text-[12px] leading-relaxed text-text-3">
          {signalId
            ? // The engine declined this signal. The account layer would refuse
              // it too, and saying so here avoids a pointless round trip.
              'This signal was not accepted by the engine, so it cannot be acted on.'
            : 'No signal is available to act on yet.'}
        </p>
      </Shell>
    );
  }

  if (!signedIn) {
    return (
      <Shell>
        <p className="text-[12px] leading-relaxed text-text-3">
          Sign in to evaluate this signal against your account risk policy. Paper positions belong
          to an account.
        </p>
        <a
          href="/signin"
          className="inline-flex h-9 w-fit items-center rounded-[6px] border border-edge-strong px-3 text-[12px] text-text-2 transition-colors hover:border-accent/40 hover:text-text-1"
        >
          Sign in
        </a>
      </Shell>
    );
  }

  // A position already exists on this signal. The panel becomes a report of it
  // rather than an invitation to open a second one.
  if (position) return <PositionState position={position} />;

  // Risk refuses any action on this signal, so no CTA is offered at all. The
  // reasons come from the engine, not from a guess reconstructed here.
  if (actionability && !actionability.allowed) {
    const failed = actionability.evaluations.filter((rule) => !rule.passed);
    return (
      <Shell>
        <Headline tone="warn">No paper action</Headline>
        <p className="text-[12px] leading-relaxed text-text-2">
          {OUTCOME_COPY[actionability.outcome] ?? actionability.outcome}
          {actionability.retryAfterMs !== null ? (
            <span className="tnum text-warn">
              {' '}
              · clears in {Math.ceil(actionability.retryAfterMs / 1000)}s
            </span>
          ) : null}
        </p>
        <ul className="flex flex-col gap-1.5">
          {failed.slice(0, 4).map((rule) => (
            <li key={rule.code} className="flex items-baseline gap-2 text-[11px]">
              <span
                aria-hidden
                className="mt-[5px] inline-block h-[5px] w-[5px] shrink-0 rounded-full bg-bear"
              />
              {/* The engine's own sentence, which states the actual condition
                  rather than the word "blocked". */}
              <span className="min-w-0 text-text-2">{rule.detail}</span>
            </li>
          ))}
        </ul>
      </Shell>
    );
  }

  const busy = phase.kind === 'working';
  const resulting = capacity ? capacity.committedUnits + (sizeUsable ? numericSize : 0) : null;
  const overSize = capacity !== null && sizeUsable && numericSize > capacity.maxPositionSize;

  // ------------------------------------------------------ confirm surface --

  if (phase.kind === 'confirming') {
    return (
      <Shell>
        <Headline>Confirm paper action</Headline>
        <dl className="flex flex-col divide-y divide-edge/70 rounded-[6px] border border-edge bg-surface-2">
          <Line label="Instrument" value={instrument ?? '—'} />
          <Line label="Timeframe" value={timeframe ?? '—'} />
          <Line
            label="Direction"
            value={
              <span className={direction === 'call' ? 'text-bull' : 'text-bear'}>
                {direction ? `PAPER ${direction.toUpperCase()}` : '—'}
              </span>
            }
          />
          <Line label="Requested size" value={`${units(numericSize)} units`} />
          <Line
            label="Current exposure"
            value={capacity ? `${units(capacity.committedUnits)} units` : '—'}
          />
          <Line
            label="Resulting exposure"
            value={resulting === null ? '—' : `${units(resulting)} units`}
          />
          <Line label="Expiry" value={expirySeconds === null ? '—' : `${expirySeconds}s`} />
          <Line
            label="Risk decision"
            value={
              actionability?.allowed ? (
                <span className="text-bull">Permitted</span>
              ) : (
                <span className="text-text-3">—</span>
              )
            }
          />
          {/* A simulated figure is never produced without naming the model, so
              the model is named BEFORE the action that will produce one. */}
          <Line
            label="Simulation model"
            value={
              model ? (
                `${model.name} v${model.version}`
              ) : (
                <span className="text-text-3">No simulation model</span>
              )
            }
          />
        </dl>

        <p className="rounded-[6px] border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
          Paper simulation only. No broker order will be submitted, and no counterparty exists.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={act}
            disabled={busy}
            className="h-9 rounded-[6px] border border-accent/30 bg-accent-dim px-3 text-[12px] font-medium text-accent transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Confirm paper action'}
          </button>
          <button
            type="button"
            onClick={() => setPhase({ kind: 'idle' })}
            disabled={busy}
            className="h-9 rounded-[6px] border border-edge-strong px-3 text-[12px] text-text-2 transition-colors hover:border-accent/40 hover:text-text-1 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </Shell>
    );
  }

  // -------------------------------------------------------- action surface --
  //
  // Laid out as a strip: the terms of the action read left to right, and the
  // commitment sits at the end of them. A user should be able to take in what
  // the action costs before reaching the control that starts it.

  return (
    <Shell>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-5">
          <Field
            label="Direction"
            value={
              <span className={direction === 'call' ? 'text-bull' : 'text-bear'}>
                {direction ? `PAPER ${direction.toUpperCase()}` : '—'}
              </span>
            }
          />

          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="paper-size" className="telemetry-label">
              Position size
            </label>
            <input
              id="paper-size"
              type="number"
              min="0"
              step="0.5"
              inputMode="decimal"
              value={size}
              onChange={(event) => {
                setSize(event.target.value);
                // Any earlier verdict described a different size; keeping it
                // on screen would attach a decision to a number it never
                // evaluated.
                setPhase({ kind: 'idle' });
              }}
              className="tnum h-8 w-full max-w-[120px] rounded-[6px] border border-edge-strong bg-surface-2 px-2.5 text-[13px] text-text-1 outline-none transition-colors focus:border-accent/50"
            />
          </div>

          <Field
            label="Current exposure"
            value={
              capacity ? (
                <span className="tnum">{units(capacity.committedUnits)} units</span>
              ) : (
                <span className="text-text-3">—</span>
              )
            }
          />
          <Field
            label="After action"
            value={
              resulting === null || !capacity ? (
                <span className="text-text-3">—</span>
              ) : (
                <span className="tnum">
                  {units(resulting)}
                  <span className="text-text-3"> / {units(capacity.maxPositionSize)} max</span>
                </span>
              )
            }
          />
          <Field
            label="Simulation model"
            value={
              model ? (
                <span className="truncate">
                  {model.name} <span className="tnum text-text-3">v{model.version}</span>
                </span>
              ) : (
                // Not a default and not a zero: with no model the outcome
                // produces no simulated figure at all.
                <span className="text-text-3">No simulation model</span>
              )
            }
          />
        </div>

        <button
          type="button"
          onClick={() => setPhase({ kind: 'confirming' })}
          disabled={busy || !sizeUsable || overSize}
          className="flex h-10 shrink-0 items-center justify-center gap-2 rounded-[7px] border border-accent/35 bg-accent-dim px-5 text-[12px] font-medium tracking-[0.06em] text-accent uppercase transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Take paper action
        </button>
      </div>

      {!sizeUsable ? (
        <p className="text-[11px] text-warn">Size must be a number greater than zero.</p>
      ) : null}
      {overSize && capacity ? (
        <p className="text-[11px] text-warn">
          Size exceeds this account&rsquo;s maximum position size of{' '}
          {units(capacity.maxPositionSize)} units.
        </p>
      ) : null}

      {capacity ? (
        <p className="text-[11px] text-text-3">
          Slots free {Math.max(0, capacity.maxOpenPositions - capacity.openPositions)} of{' '}
          {capacity.maxOpenPositions} · available {units(capacity.availableUnits)} units
        </p>
      ) : null}

      {phase.kind === 'refused' ? <Refusal decision={phase.decision} /> : null}

      {phase.kind === 'opened' ? (
        <p className="rounded-[6px] border border-accent/25 bg-accent-dim px-3 py-2 text-[12px] leading-relaxed text-accent">
          {phase.duplicate
            ? // The server recognised the action key and returned what already
              // existed. Saying so is what stops a user retrying into a second
              // position they did not intend.
              'Existing paper position returned. The action had already been recorded.'
            : 'Paper position opened.'}{' '}
          <span className="text-text-2">Simulated. No order was placed.</span>
        </p>
      ) : null}

      {phase.kind === 'error' ? (
        <p
          role="alert"
          className="rounded-[6px] border border-bear/25 bg-bear/8 px-3 py-2 text-[12px] text-bear"
        >
          Action failed. {phase.message}
        </p>
      ) : null}

      <p className="border-t border-edge pt-3 text-[11px] leading-relaxed text-text-3">
        By taking this action you record a simulated paper position. Your account risk policy is
        evaluated by the backend on every attempt; disabling a button here is a convenience, not the
        control.
      </p>
    </Shell>
  );
}

/** One term of the action. Label small and dim, value primary. */
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="telemetry-label">{label}</span>
      <span className="truncate text-[13px] font-medium text-text-1">{value}</span>
    </div>
  );
}
