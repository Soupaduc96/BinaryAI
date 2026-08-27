import type { ApiResult, PaperPositionView, PositionsFeed } from '@/lib/api';
import { Chip, Dormant, Locked, ModuleHeader, Surface } from '@/components/ui/primitives';

/**
 * The paper position currently in force, as a first-class rail module.
 *
 * Promoted out of the position list because an OPEN position is a live state a
 * user needs at a glance, not a row to find in a table. It reports what exists
 * and nothing more:
 *
 *  - **No simulated figure before settlement.** An open position has no
 *    outcome, and showing a projected one would present an expectation as a
 *    result.
 *  - **The model is named, not assumed.** Whatever settles this position will
 *    be valued by a stated model and version, so both are shown while it is
 *    still open.
 *  - **Absent is "—".** A missing value is never rendered as zero.
 */

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function Cell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4 py-2.5">
      <span className="telemetry-label">{label}</span>
      <span className="truncate text-[12px] text-text-1">{value}</span>
    </div>
  );
}

/** Absent, never zero. */
function Dash() {
  return <span className="text-text-3">—</span>;
}

export function ActivePositionModule({
  feed,
  model,
}: {
  feed: ApiResult<PositionsFeed>;
  /** The model that will value this position when it settles. */
  model: { readonly name: string; readonly version: string } | null;
}) {
  if (!feed.ok) {
    return (
      <Surface aria-labelledby="active-position-heading" className="flex flex-col">
        <ModuleHeader label="Active paper position" id="active-position-heading" />
        {feed.unauthorized ? (
          <Locked what="Positions are private to an account." />
        ) : (
          <div className="px-5 py-5">
            <Dormant headline={'Unavailable'} detail={feed.error} />
          </div>
        )}
      </Surface>
    );
  }

  // The live one: open, or expired and awaiting a settling bar. A settled
  // position is history and belongs in the list below, not here.
  const active = feed.data.positions.find(
    (position) => position.status === 'open' || position.status === 'pending_settlement',
  );

  if (!active) {
    return (
      <Surface aria-labelledby="active-position-heading" className="flex flex-col">
        <ModuleHeader label="Active paper position" id="active-position-heading" />
        <div className="px-5 py-5">
          <Dormant
            headline="No active position"
            detail="Taking a paper action on an accepted signal opens one. It appears here until it settles."
          />
        </div>
      </Surface>
    );
  }

  return <ActivePositionCard position={active} model={model} />;
}

function ActivePositionCard({
  position,
  model,
}: {
  position: PaperPositionView;
  model: { readonly name: string; readonly version: string } | null;
}) {
  const awaiting = position.status === 'pending_settlement';
  const isCall = position.direction === 'call';

  return (
    <Surface aria-labelledby="active-position-heading" className="flex flex-col">
      <ModuleHeader
        label="Active paper position"
        id="active-position-heading"
        meta={position.id.slice(0, 8)}
      />

      {/* The direction, given the weight of a live state. A thin accent rule
          rather than a filled block: this is a position, not a celebration. */}
      <div className="relative flex items-center justify-between gap-4 px-5 py-4">
        <span
          aria-hidden
          className={`absolute inset-y-3 left-0 w-[2px] rounded-r ${isCall ? 'bg-bull' : 'bg-bear'}`}
        />
        <span
          className={`text-[30px] leading-none font-semibold tracking-tight ${
            isCall ? 'text-bull' : 'text-bear'
          }`}
        >
          PAPER {position.direction.toUpperCase()}
        </span>
        <span className="flex flex-col items-end gap-1">
          <span className="telemetry-label">Status</span>
          <span className={`text-[12px] font-medium ${awaiting ? 'text-warn' : 'text-accent'}`}>
            {awaiting ? 'UNRESOLVED' : 'ACTIVE'}
          </span>
        </span>
      </div>

      <div className="grid grid-cols-3 divide-x divide-edge border-y border-edge">
        <Cell label="Exposure" value={<span className="tnum">{position.size} units</span>} />
        <Cell label="Opened" value={<span className="tnum">{clock(position.openedAt)}</span>} />
        <Cell label="Expires" value={<span className="tnum">{clock(position.expiresAt)}</span>} />
      </div>

      <div className="grid grid-cols-2 divide-x divide-edge border-b border-edge">
        <Cell
          label="Instrument"
          value={
            <>
              {position.assetSymbol} <span className="tnum text-text-3">{position.timeframe}</span>
            </>
          }
        />
        <Cell
          label="Signal"
          value={<span className="tnum text-text-2">{position.signalId.slice(0, 8)}</span>}
        />
      </div>

      <div className="grid grid-cols-2 divide-x divide-edge">
        <Cell
          label="Simulation model"
          value={model ? model.name : <span className="text-text-3">None selected</span>}
        />
        <Cell
          label="Version"
          value={model ? <span className="tnum">v{model.version}</span> : <Dash />}
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-edge px-5 py-3">
        <span className="telemetry-label">Settlement</span>
        <Chip tone={awaiting ? 'warn' : 'neutral'}>{awaiting ? 'awaiting bar' : 'pending'}</Chip>
      </div>

      {/* Stated while the position is open, because this is exactly when a
          user is most inclined to read a number that does not exist yet. */}
      <p className="border-t border-edge px-5 py-3 text-[10.5px] leading-relaxed text-text-3">
        {awaiting
          ? 'Expired with no usable settling bar yet. This is not a loss, and no simulated value exists.'
          : 'No simulated return exists until this position settles. Simulated, and not a broker order.'}
      </p>
    </Surface>
  );
}
