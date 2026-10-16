import type {
  ApiResult,
  PaperAccountFeed,
  PaperPositionView,
  PositionsFeed,
  RiskEventsFeed,
  RiskPolicyFeed,
} from '@/lib/api';
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

/**
 * The paper account workspace.
 *
 * Extends the terminal rather than replacing it: the same surfaces, hairlines
 * and type scale as every other module. Three rules govern what it may say:
 *
 *  - **Units are never presented as money.** No currency symbol, no "balance",
 *    and the accounting note travels with the figures.
 *  - **No celebration.** A settled win is a row that says "win", in the same
 *    weight as a loss. There is nothing to congratulate.
 *  - **Risk status describes rules, not vibes.** "Within limits" is a statement
 *    about what was evaluated, not a reassuring green light.
 */

const STATUS_TONE = {
  open: 'accent',
  pending_settlement: 'warn',
  settled: 'neutral',
  cancelled: 'neutral',
  rejected: 'neutral',
} as const;

const STATUS_LABEL = {
  open: 'open',
  // Spelled out rather than shortened to "pending": the distinction from
  // "open" is the whole point of the state.
  pending_settlement: 'awaiting settlement',
  settled: 'settled',
  cancelled: 'cancelled',
  rejected: 'rejected',
} as const;

const RESULT_TONE = { win: 'bull', loss: 'bear', tie: 'neutral', unresolved: 'warn' } as const;

function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

// ------------------------------------------------------------- account --

export function PaperAccountModule({ feed }: { feed: ApiResult<PaperAccountFeed> }) {
  if (!feed.ok) {
    return (
      <Surface aria-labelledby="paper-heading" className="flex flex-col">
        <ModuleHeader label="Kont papye" id="paper-heading" />
        {feed.unauthorized ? (
          <Locked what="Yon kont papye apatni a yon itilizatè ki konekte." />
        ) : (
          <div className="px-5 py-5">
            <Dormant headline={failureHeadline(feed)} detail={feed.error} />
          </div>
        )}
      </Surface>
    );
  }

  const { paper } = feed.data;
  const configured = paper.accountingModel === 'exposure_only';

  return (
    <Surface aria-labelledby="paper-heading" className="flex flex-col">
      <ModuleHeader
        label="Kont papye"
        id="paper-heading"
        meta={paper.unit}
        // Says what this is on every render. A user must never wonder whether
        // these numbers represent money.
        action={<Chip tone="warn">simulated</Chip>}
      />
      <div className="flex flex-1 flex-col gap-5 px-5 py-5">
        {!configured ? (
          <Dormant
            headline="Modèl kontablite pa konfigire"
            detail="This account has no unit allocation, so exposure cannot be tracked. No balance is shown because none exists."
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-6 gap-y-5">
              <DataPair
                label="Disponib"
                value={<span className="tnum">{paper.availableUnits}</span>}
                size="lg"
              />
              <DataPair
                label="Angaje"
                value={<span className="tnum">{paper.committedUnits}</span>}
                size="lg"
              />
              <DataPair label="Alwe" value={<span className="tnum">{paper.allocatedUnits}</span>} />
              <DataPair
                label="Pozisyon ouvè"
                value={<span className="tnum">{paper.openPositions}</span>}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="eyebrow">Settled</span>
              <span className="tnum text-[13px] text-text-2">{paper.settledPositions}</span>
              {paper.lastActivityAt !== null ? (
                <>
                  <span aria-hidden className="text-text-3">
                    ·
                  </span>
                  <span className="text-[12px] text-text-3">
                    last activity {formatTime(paper.lastActivityAt)}
                  </span>
                </>
              ) : null}
            </div>

            {/* The sentence that keeps units from reading as a balance. */}
            <p className="border-t border-edge pt-4 text-[12px] leading-relaxed text-text-3">
              {paper.accountingNote}
            </p>
          </>
        )}
      </div>
    </Surface>
  );
}

// ---------------------------------------------------------------- risk --

export function AccountRiskModule({
  policy,
  account,
  events,
}: {
  policy: ApiResult<RiskPolicyFeed>;
  account: ApiResult<PaperAccountFeed>;
  events: ApiResult<RiskEventsFeed>;
}) {
  if (!policy.ok) {
    return (
      <Surface aria-labelledby="account-risk-heading" className="flex flex-col">
        <ModuleHeader label="Risk kont" id="account-risk-heading" />
        {policy.unauthorized ? (
          <Locked what="Limit risk yo se pa kont." />
        ) : (
          <div className="px-5 py-5">
            <Dormant headline={failureHeadline(policy)} detail={policy.error} />
          </div>
        )}
      </Surface>
    );
  }

  const { limits, maxPositionSize, maxDailyExposure, version } = policy.data.policy;
  const open = account.ok ? account.data.paper.openPositions : null;
  const remaining = open === null ? null : Math.max(0, limits.maxOpenPositions - open);
  const blocks = events.ok
    ? events.data.events.filter((event) => event.severity !== 'info').slice(0, 3)
    : [];

  return (
    <Surface aria-labelledby="account-risk-heading" className="flex flex-col">
      <ModuleHeader
        label="Risk kont"
        id="account-risk-heading"
        meta={`policy v${version}`}
        action={<Chip tone="accent">enforced</Chip>}
      />
      <div className="flex flex-1 flex-col gap-5 px-5 py-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-5">
          <DataPair
            label="Plas lib"
            value={
              remaining === null ? (
                <Absent />
              ) : (
                // "1 / 1" is ambiguous -- it reads equally as "1 used of 1",
                // which is the opposite state. Spelling out "of N" removes the
                // reading in which a user thinks they are at their limit.
                <span className="tnum">
                  {remaining}
                  <span className="text-[13px] text-text-3"> of {limits.maxOpenPositions}</span>
                </span>
              )
            }
            size="lg"
          />
          <DataPair
            label="Ekspozisyon itilize"
            value={
              account.ok ? (
                <span className="tnum">
                  {account.data.paper.committedUnits}
                  <span className="text-[13px] text-text-3"> of {maxDailyExposure}</span>
                </span>
              ) : (
                <Absent />
              )
            }
            size="lg"
          />
          <DataPair
            label="Max position size"
            value={<span className="tnum">{maxPositionSize}</span>}
          />
          <DataPair
            label="Limit seri pèt"
            value={<span className="tnum">{limits.maxConsecutiveLosses}</span>}
          />
        </div>

        {/* Deliberately not a green "safe" badge. This states what was
            evaluated, not that nothing could go wrong. */}
        <p className="text-[12px] leading-relaxed text-text-3">
          {policy.data.enforcement} Cooldown after a loss:{' '}
          <span className="tnum">{limits.cooldownSecondsAfterLoss}s</span>.
        </p>

        <div className="flex flex-col gap-2 border-t border-edge pt-4">
          <span className="eyebrow">Recent refusals</span>
          {blocks.length === 0 ? (
            <p className="text-[12px] text-text-3">
              No actions have been refused. This is a record of what happened, not a guarantee about
              what will.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {blocks.map((event) => (
                <li key={event.id} className="flex items-baseline gap-2 text-[12px]">
                  <span className="tnum shrink-0 text-text-3">{formatTime(event.at)}</span>
                  <Chip tone={event.severity === 'critical' ? 'bear' : 'warn'}>
                    {event.code.replace(/_/g, ' ')}
                  </Chip>
                  <span className="min-w-0 truncate text-text-2">{event.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Surface>
  );
}

// ----------------------------------------------------------- positions --

export function PaperPositionsModule({ feed }: { feed: ApiResult<PositionsFeed> }) {
  if (!feed.ok) {
    return (
      <Surface aria-labelledby="positions-heading" className="flex flex-col">
        <ModuleHeader label="Pozisyon papye" id="positions-heading" />
        {feed.unauthorized ? (
          <Locked what="Pozisyon yo prive pou yon kont." />
        ) : (
          <div className="px-5 py-5">
            <Dormant headline={failureHeadline(feed)} detail={feed.error} />
          </div>
        )}
      </Surface>
    );
  }

  const { positions, accounting } = feed.data;

  return (
    <Surface aria-labelledby="positions-heading" className="flex flex-col">
      <ModuleHeader
        label="Pozisyon papye"
        id="positions-heading"
        meta={positions.length > 0 ? `${positions.length} recorded` : undefined}
        action={<Chip tone="warn">simulated</Chip>}
      />
      <div className="flex flex-1 flex-col gap-4 px-5 py-5">
        {positions.length === 0 ? (
          <Dormant
            headline="Pa gen pozisyon papye"
            detail="Positions appear here after you act on a signal and your account risk policy permits it."
          />
        ) : (
          <ul className="flex flex-col">
            {positions.map((position) => (
              <PositionRow key={position.id} position={position} />
            ))}
          </ul>
        )}
        <p className="border-t border-edge pt-4 text-[12px] leading-relaxed text-text-3">
          {accounting}
        </p>
      </div>
    </Surface>
  );
}

function PositionRow({ position }: { position: PaperPositionView }) {
  const settled = position.status === 'settled';

  return (
    <li className="flex flex-col gap-1 border-b border-edge/60 py-2.5 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-2">
          <Chip tone={position.direction === 'call' ? 'bull' : 'bear'}>{position.direction}</Chip>
          <span className="truncate text-[13px] text-text-2">{position.assetSymbol}</span>
          <span className="tnum text-[11px] text-text-3">{position.timeframe}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {/* Result and status are separate: an open position has no result,
              and showing one would read as a settled loss. */}
          {settled && position.result ? (
            <Chip tone={RESULT_TONE[position.result]}>{position.result}</Chip>
          ) : null}
          <Chip tone={STATUS_TONE[position.status]}>{STATUS_LABEL[position.status]}</Chip>
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11px] text-text-3">
        <span>
          size <span className="tnum text-text-2">{position.size}</span>
        </span>
        <span>
          entry <span className="tnum text-text-2">{position.entryPrice}</span>
        </span>
        <span>
          expiry <span className="tnum text-text-2">{formatTime(position.expiresAt)}</span>
        </span>
        {settled && position.settlementPrice !== null ? (
          <span>
            settled at <span className="tnum text-text-2">{position.settlementPrice}</span>
          </span>
        ) : null}
      </div>
    </li>
  );
}
