import type { PersistedSignal, SystemStatus } from '@binaryai/types';
import type { ApiResult, PaperAccountFeed, RiskPolicyFeed, SimulationFeed } from '@/lib/api';
import {
  Absent,
  Chip,
  Dormant,
  Locked,
  Surface,
  failureHeadline,
} from '@/components/ui/primitives';
import { TONE_DOT, TONE_TEXT, componentIndicator } from '@/lib/system-state';

/**
 * The right rail: decision context, risk, account and system health.
 *
 * These are narrow modules — roughly a third of the workspace — so they use a
 * label-left / value-right rhythm rather than the stat grids the wide column
 * can afford. Density is the point; a user scans this rail rather than reading
 * it.
 *
 * Every value comes from the API. Where a value does not exist the module says
 * so, and none of them infer health from configuration.
 */

function ModuleHead({
  title,
  badge,
  badgeTone = 'neutral',
}: {
  title: string;
  badge?: string;
  badgeTone?: 'neutral' | 'accent' | 'bull' | 'bear' | 'warn';
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
      <h2 className="eyebrow text-[10px]">{title}</h2>
      {badge ? <Chip tone={badgeTone}>{badge}</Chip> : null}
    </header>
  );
}

/** Label left, value right. The rail's basic unit. */
function Row({
  label,
  value,
  tone = 'text-text-1',
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2">
      <span className="text-[12px] text-text-3">{label}</span>
      <span className={`text-[12px] font-medium ${tone}`}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------- risk --

const RISK_TONE: Record<string, string> = {
  low: 'text-bull',
  medium: 'text-warn',
  high: 'text-bear',
  extreme: 'text-bear',
};

/**
 * Risk assessment for the account, against the signal in view.
 *
 * "Approved" here means the account policy currently permits an action — it is
 * a statement about limits, not a judgement that the trade is a good one. The
 * reasons come from the risk engine and the account policy; none are written
 * for display.
 */
export function RiskAssessmentModule({
  policy,
  account,
  detail,
}: {
  policy: ApiResult<RiskPolicyFeed>;
  account: ApiResult<PaperAccountFeed>;
  detail: PersistedSignal | null;
}) {
  if (!policy.ok) {
    return (
      <Surface className="flex flex-col">
        <ModuleHead title="Risk assessment" />
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

  const { limits, maxDailyExposure } = policy.data.policy;
  const paper = account.ok ? account.data.paper : null;
  const open = paper?.openPositions ?? 0;
  const committed = paper?.committedUnits ?? 0;
  const available = paper?.availableUnits ?? 0;

  // Capacity is the only thing that can be assessed without a signal. The
  // engine's own verdict on the signal is shown beneath when one exists.
  const hasCapacity = open < limits.maxOpenPositions && available > 0;
  const signalRisk = detail?.signal.riskLevel ?? null;
  const engineBlocked = detail ? detail.signal.status === 'rejected' : false;

  const approved = hasCapacity && !engineBlocked;

  // Each reason is phrased for the state it is actually in. Labelling a FAILING
  // rule "Within open-position limit (1 of 1)" reads as a pass and contradicts
  // the badge above it -- the exact defect this wording replaced.
  const slotsFree = open < limits.maxOpenPositions;
  const hasUnits = available > 0;
  const withinWindow = committed <= maxDailyExposure;

  const reasons: { text: string; ok: boolean }[] = [
    {
      text: slotsFree
        ? `Open-position slot free (${open} of ${limits.maxOpenPositions} used)`
        : `At open-position limit (${open} of ${limits.maxOpenPositions} used)`,
      ok: slotsFree,
    },
    {
      text: hasUnits
        ? `Exposure available (${available} units)`
        : 'No exposure available; every allocated unit is committed',
      ok: hasUnits,
    },
    {
      text: withinWindow
        ? `Exposure within the ${maxDailyExposure}-unit window (${committed} used)`
        : `Exposure window exhausted (${committed} of ${maxDailyExposure})`,
      ok: withinWindow,
    },
    ...(detail
      ? [
          {
            text: engineBlocked ? 'Engine rejected this signal' : 'Engine accepted this signal',
            ok: !engineBlocked,
          },
        ]
      : []),
  ];

  return (
    <Surface className="flex flex-col">
      <ModuleHead
        title="Risk assessment"
        badge={approved ? 'capacity free' : 'no capacity'}
        badgeTone={approved ? 'bull' : 'warn'}
      />
      <div className="flex flex-col divide-y divide-edge/70">
        <Row
          label="Nivo risk"
          value={
            signalRisk ? (
              <span className={RISK_TONE[signalRisk] ?? 'text-text-1'}>
                {signalRisk.toUpperCase()}
              </span>
            ) : (
              <Absent />
            )
          }
        />
        <Row label="Ekspozisyon" value={<span className="tnum">{committed} units</span>} />
        <Row label="Disponib" value={<span className="tnum">{available} units</span>} />
        {/* "X of Y" rather than "X / Y": a slash reads as a ratio, and a
            reader cannot tell which side is the limit. */}
        <Row
          label="Plas lib"
          value={
            <span className="tnum">
              {Math.max(0, limits.maxOpenPositions - open)} of {limits.maxOpenPositions}
            </span>
          }
        />
        <Row label="Pozisyon ouvè" value={<span className="tnum">{open}</span>} />
      </div>

      <div className="flex flex-col gap-2 border-t border-edge px-4 py-3">
        <span className="eyebrow text-[10px]">
          {approved ? 'Why an action is permitted' : 'Why an action would be refused'}
        </span>
        <ul className="flex flex-col gap-1.5">
          {reasons.map((reason) => (
            <li key={reason.text} className="flex items-baseline gap-2 text-[11px]">
              <span
                aria-hidden
                className={`mt-[5px] h-[5px] w-[5px] shrink-0 rounded-full ${
                  reason.ok ? 'bg-bull' : 'bg-bear'
                }`}
              />
              <span className="min-w-0 text-text-2">{reason.text}</span>
            </li>
          ))}
        </ul>
        {/* Says what "approved" does and does not mean. */}
        <p className="text-[10px] leading-relaxed text-text-3">
          Capacity only. This says your limits permit an action, not that the action is a good one.
        </p>
      </div>
    </Surface>
  );
}

// ------------------------------------------------------------- account --

/**
 * Account overview.
 *
 * EXPOSURE and SIMULATED ACCOUNT VALUE are shown as separate, separated
 * quantities, because conflating them is the single easiest way for this
 * screen to mislead. Exposure is a capacity fact: units committed against open
 * positions, which return in full when they settle. Simulated value is
 * arithmetic on a stated model and moves with outcomes. One is a fact about
 * the account; the other is a figure produced by a premise.
 */
export function AccountOverviewModule({
  account,
  policy,
  simulation,
}: {
  account: ApiResult<PaperAccountFeed>;
  policy: ApiResult<RiskPolicyFeed>;
  simulation: ApiResult<SimulationFeed>;
}) {
  if (!account.ok) {
    return (
      <Surface className="flex flex-col">
        <ModuleHead title="Account overview" />
        {account.unauthorized ? (
          <Locked what="Yon kont papye apatni a yon itilizatè ki konekte." />
        ) : (
          <div className="px-5 py-5">
            <Dormant headline={failureHeadline(account)} detail={account.error} />
          </div>
        )}
      </Surface>
    );
  }

  const { account: meta, paper } = account.data;
  const simulated = simulation.ok ? simulation.data.simulation : null;
  const maxOpen = policy.ok ? policy.data.policy.limits.maxOpenPositions : null;
  const slotsFree = maxOpen === null ? null : Math.max(0, maxOpen - paper.openPositions);

  return (
    <Surface className="flex flex-col">
      <ModuleHead title="Account overview" badge="paper mode" badgeTone="warn" />
      <div className="flex flex-col divide-y divide-edge/70">
        <Row label="Kont" value={meta.name} />
        <Row
          label="Plas lib"
          value={
            slotsFree === null ? (
              <Absent />
            ) : (
              <span className="tnum">
                {slotsFree} of {maxOpen}
              </span>
            )
          }
        />
        <Row label="Pozisyon ouvè" value={<span className="tnum">{paper.openPositions}</span>} />
        {/* Never "balance": these are accounting units, not money. */}
        <Row
          label="Ekspozisyon alwe"
          value={<span className="tnum">{paper.allocatedUnits} units</span>}
        />
        <Row
          label="Ekspozisyon disponib"
          value={<span className="tnum">{paper.availableUnits} units</span>}
        />
        <Row label="Egzekisyon an dirèk" value={<span className="text-bear">DISABLED</span>} />
      </div>

      {/* Below the divider, and labelled, so it cannot be read as part of the
          exposure figures above it. */}
      <div className="flex flex-col border-t border-edge">
        <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-1">
          <span className="eyebrow text-[10px]">Simulated account value</span>
          <Chip tone={simulated?.enabled ? 'warn' : 'neutral'}>
            {simulated?.enabled ? 'simulated' : 'off'}
          </Chip>
        </div>
        {simulated?.enabled && simulated.model ? (
          <div className="flex flex-col divide-y divide-edge/70">
            <Row
              label="Aktyèl"
              value={
                simulated.currentUnits === null ? (
                  <Absent />
                ) : (
                  <span className="tnum">{simulated.currentUnits.toFixed(2)} units</span>
                )
              }
            />
            <Row
              label="Model"
              value={
                <span className="tnum text-[11px]">
                  {simulated.model.modelKey} v{simulated.model.version}
                </span>
              }
            />
          </div>
        ) : (
          <p className="px-4 pb-3 text-[11px] text-text-3">
            {/* Not a zero. No model means no simulated value exists at all. */}
            No simulation model is selected, so this account has no simulated value.
          </p>
        )}
      </div>

      <p className="border-t border-edge px-4 py-3 text-[10px] leading-relaxed text-text-3">
        Exposure is an accounting quantity, not currency and not money held by BinaryAI. Simulated
        value is computed by a stated model and is not a broker result.
      </p>
    </Surface>
  );
}

// -------------------------------------------------------------- system --

/**
 * Component labels.
 *
 * CSS `capitalize` renders "api" as "Api" and "ai" as "Ai". Acronyms need an
 * explicit map; there is no styling rule that gets them right.
 */
const COMPONENT_LABEL: Record<string, string> = {
  api: 'API',
  ai: 'AI',
  database: 'Database',
  rate_limiter: 'Rate limiter',
  market_data: 'Market data',
  analysis: 'Analysis',
  settlement: 'Settlement',
  maintenance: 'Session retention',
  broker: 'Broker',
};

export function SystemStatusModule({ status }: { status: ApiResult<SystemStatus> }) {
  if (!status.ok) {
    return (
      <Surface className="flex flex-col">
        <ModuleHead title="System status" />
        {status.unauthorized ? (
          <Locked what="API a ap kouri; sante konpozan yo mande yon sesyon." />
        ) : (
          <div className="px-5 py-5">
            <Dormant headline={'API unreachable'} detail={status.error} />
          </div>
        )}
      </Surface>
    );
  }

  const uptime = status.data.uptimeSeconds;
  const uptimeLabel =
    uptime < 60
      ? `${uptime}s`
      : uptime < 3600
        ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
        : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

  return (
    <Surface className="flex flex-col">
      <ModuleHead title="System status" badge={status.data.version} />
      <div className="flex flex-col divide-y divide-edge/70">
        {status.data.components.map((component) => {
          // Health comes from the API's runtime state, never from whether a
          // setting is present.
          const indicator = componentIndicator(component.health, component.detail);
          return (
            <div
              key={component.component}
              className="flex items-baseline justify-between gap-3 px-4 py-2"
              title={indicator.detail}
            >
              <span className="text-[12px] text-text-3">
                {COMPONENT_LABEL[component.component] ?? component.component.replace(/_/g, ' ')}
              </span>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`h-[5px] w-[5px] rounded-full ${TONE_DOT[indicator.tone]}`}
                />
                <span className={`text-[11px] font-medium ${TONE_TEXT[indicator.tone]}`}>
                  {indicator.value}
                </span>
              </span>
            </div>
          );
        })}
        <Row label="Tan aktif" value={<span className="tnum">{uptimeLabel}</span>} />
      </div>
    </Surface>
  );
}
