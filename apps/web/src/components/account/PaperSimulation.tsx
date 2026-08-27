import type { ApiResult, SimulationFeed, SimulationModelsFeed } from '@/lib/api';
import {
  Absent,
  Chip,
  DataPair,
  Dormant,
  Locked,
  ModuleHeader,
  Surface,
  failureHeadline,
} from '@/components/ui/primitives';
import { ModelSelect } from '@/components/account/ModelSelect';

/**
 * Paper simulation: what a named model computes the outcomes to be worth.
 *
 * Deliberately a separate module from "Observed outcomes", which reports
 * measured directional accuracy and applies no model at all. Putting them in
 * one panel would invite the reading that BinaryAI measured a monetary result.
 * It did not, and cannot: there is no broker and no counterparty.
 *
 * Three rules this module holds to, each of which has a failure mode it
 * prevents:
 *
 *  - **No model means ABSENT, not zero.** A zero reads as "broke even"; the
 *    truth is "nothing was computed".
 *  - **A figure never appears without its model and version.** Otherwise the
 *    number looks like an observation rather than arithmetic on a premise.
 *  - **Units are never money.** No currency symbol appears anywhere here.
 */

const LOSS_RULE_LABEL: Record<string, string> = {
  forfeit_exposure: 'exposure forfeited',
  partial_refund: 'partial refund',
};

const TIE_RULE_LABEL: Record<string, string> = {
  refund_exposure: 'exposure returned',
  treat_as_loss: 'treated as incorrect',
};

/** Signed, with an explicit sign so a positive figure cannot be misread. */
function signed(value: number): string {
  const fixed = Math.abs(value) < 0.005 ? '0.00' : Math.abs(value).toFixed(2);
  if (Math.abs(value) < 0.005) return '0.00';
  return `${value > 0 ? '+' : '−'}${fixed}`;
}

function toneFor(value: number): string {
  if (Math.abs(value) < 0.005) return 'text-text-1';
  return value > 0 ? 'text-bull' : 'text-bear';
}

export function PaperSimulationModule({
  feed,
  catalogue,
}: {
  feed: ApiResult<SimulationFeed>;
  catalogue: ApiResult<SimulationModelsFeed>;
}) {
  if (!feed.ok) {
    return (
      <Surface aria-labelledby="sim-heading" className="flex flex-col">
        <ModuleHeader label="Paper simulation" id="sim-heading" />
        {feed.unauthorized ? (
          <Locked what="A paper simulation is per account." />
        ) : (
          <div className="px-5 py-5">
            <Dormant headline={failureHeadline(feed)} detail={feed.error} />
          </div>
        )}
      </Surface>
    );
  }

  const { simulation, separation } = feed.data;
  const { model } = simulation;
  // Only offered when the catalogue actually loaded. A selector with no
  // options would look broken rather than empty.
  const models = catalogue.ok ? catalogue.data.models : [];

  // SIMULATION OFF is a real state with its own rendering, not a zeroed
  // version of the configured one.
  if (!simulation.enabled || !model) {
    return (
      <Surface aria-labelledby="sim-heading" className="flex flex-col">
        <ModuleHeader
          label="Paper simulation"
          id="sim-heading"
          action={<Chip tone="neutral">simulation off</Chip>}
        />
        <div className="flex flex-1 flex-col gap-4 px-5 py-5">
          <Dormant
            headline="No simulation model selected"
            detail="Outcomes are recorded and exposure is accounted for, but no simulated value is derived from them. Selecting a model states the rules a figure would be computed under."
          />
          {/* The counts are real even with no model, so they are reported. */}
          <dl className="grid grid-cols-3 gap-x-4 gap-y-1 border-t border-edge pt-3">
            {[
              ['Wins', simulation.wins],
              ['Losses', simulation.losses],
              ['Ties', simulation.ties],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex flex-col gap-0.5">
                <dt className="eyebrow text-[10px]">{label}</dt>
                <dd className="tnum text-[15px] font-semibold text-text-1">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[11px] leading-relaxed text-text-3">{simulation.disclosure}</p>
          {models.length > 0 ? (
            <div className="border-t border-edge pt-3">
              <ModelSelect models={models} selectedId={null} />
            </div>
          ) : null}
        </div>
      </Surface>
    );
  }

  const { parameters } = model;

  return (
    <Surface aria-labelledby="sim-heading" className="flex flex-col">
      <ModuleHeader
        label="Paper simulation"
        id="sim-heading"
        action={<Chip tone="warn">simulated</Chip>}
      />

      {/* The label that must never be absent from this module. Its own band
          rather than a chip beside the title: at three-across it did not fit,
          and it overlapped the heading rather than wrapping. */}
      <p className="border-b border-warn/25 bg-warn/10 px-5 py-2 text-[10px] font-medium tracking-[0.12em] text-warn uppercase">
        Simulated — not broker performance
      </p>

      <div className="flex flex-1 flex-col gap-5 px-5 py-5">
        {/* ---- which model, and which version of it ---- */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-[8px] border border-edge bg-surface-2/40 px-4 py-2.5">
          <span className="min-w-0 text-[13px] font-medium break-words text-text-1">
            {model.name}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="tnum text-[11px] text-text-3">v{model.version}</span>
            <Chip tone={model.status === 'active' ? 'bull' : 'neutral'}>{model.status}</Chip>
          </span>
        </div>

        {/* ---- the figures ---- */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-5">
          <DataPair
            label="Starting units"
            value={
              simulation.startingUnits === null ? (
                <Absent />
              ) : (
                <span className="tnum">{simulation.startingUnits.toFixed(2)}</span>
              )
            }
          />
          <DataPair
            label="Current simulated units"
            value={
              simulation.currentUnits === null ? (
                <Absent />
              ) : (
                <span className="tnum">{simulation.currentUnits.toFixed(2)}</span>
              )
            }
          />
          <DataPair
            label="Simulated return"
            value={
              simulation.simulatedReturn === null ? (
                <Absent />
              ) : (
                <span className={`tnum ${toneFor(simulation.simulatedReturn)}`}>
                  {signed(simulation.simulatedReturn)}
                </span>
              )
            }
          />
          <DataPair
            label="Return"
            value={
              // Null when starting units are zero: a percentage of nothing is
              // undefined, and printing one would be fabricated precision.
              simulation.returnFraction === null ? (
                <Absent />
              ) : (
                <span className={`tnum ${toneFor(simulation.returnFraction)}`}>
                  {signed(simulation.returnFraction * 100)}%
                </span>
              )
            }
          />
        </div>

        {/* ---- what settled, including what did not ---- */}
        <dl className="grid grid-cols-4 gap-x-3 gap-y-1 border-t border-edge pt-3">
          {[
            ['Wins', simulation.wins, 'text-bull'],
            ['Losses', simulation.losses, 'text-bear'],
            ['Ties', simulation.ties, 'text-text-1'],
            // Its own column. An unresolved position has no outcome, and
            // folding it into losses would invent one the market never gave.
            ['Unresolved', simulation.unresolved, 'text-warn'],
          ].map(([label, value, tone]) => (
            <div key={String(label)} className="flex min-w-0 flex-col gap-0.5">
              <dt className="eyebrow text-[10px]">{label}</dt>
              <dd className={`tnum text-[15px] font-semibold ${tone}`}>{value}</dd>
            </div>
          ))}
        </dl>

        {/* ---- the arithmetic: one disclosure away, never hidden ---- */}
        <details className="group border-t border-edge pt-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[11px] text-text-3 transition-colors hover:text-text-2">
            <span className="eyebrow text-[10px]">Model detail</span>
            <span className="flex items-center gap-1.5">
              rules, parameters and selection
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className="h-3 w-3 transition-transform group-open:rotate-180"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M4 6.5 8 10.5 12 6.5" />
              </svg>
            </span>
          </summary>

          <div className="flex flex-col gap-3 pt-3">
            <p className="text-[11px] leading-relaxed text-text-3">{model.description}</p>
            <div className="flex flex-col gap-2">
              <span className="eyebrow text-[10px]">Simulation parameters</span>
              <dl className="flex flex-col gap-1.5">
                {[
                  [
                    'Correct call',
                    `+${Math.round(parameters.simulatedReturnRate * 100)}% of exposure`,
                  ],
                  [
                    'Incorrect call',
                    parameters.lossRule === 'partial_refund'
                      ? `${Math.round(parameters.lossRefundRate * 100)}% of exposure returned`
                      : (LOSS_RULE_LABEL[parameters.lossRule] ?? parameters.lossRule),
                  ],
                  ['Exact tie', TIE_RULE_LABEL[parameters.tieRule] ?? parameters.tieRule],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex items-baseline justify-between gap-3">
                    <dt className="text-[11px] text-text-3">{label}</dt>
                    <dd className="min-w-0 text-right text-[11px] text-text-2">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {models.length > 0 ? (
              <div className="border-t border-edge pt-3">
                <ModelSelect models={models} selectedId={model.id} />
              </div>
            ) : null}
          </div>
        </details>

        {/* The sentences that keep every figure above in context. NEVER behind
            a disclosure: a simulated number is not safe to show without them. */}
        <div className="flex flex-col gap-2 border-t border-edge pt-3">
          <p className="text-[11px] leading-relaxed text-text-3">{simulation.disclosure}</p>
          <p className="text-[11px] leading-relaxed text-text-3">{separation}</p>
        </div>
      </div>
    </Surface>
  );
}
