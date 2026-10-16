import type { SystemStatus } from '@binaryai/types';
import type { ApiResult } from '@/lib/api';
import {
  Dormant,
  ModuleHeader,
  StatusDot,
  Surface,
  type HealthKind,
} from '@/components/ui/primitives';

/**
 * System status — accessible but subordinate.
 *
 * A compact strip rather than a panel of cards. Each component reports the
 * state the API actually returns; "not configured" is shown as exactly that,
 * because a terminal that overstates its own readiness is worse than one that
 * admits what is missing.
 */

const LABEL: Record<string, string> = {
  api: 'API',
  database: 'Database',
  rate_limiter: 'Rate Limiter',
  market_data: 'Market Data',
  broker: 'Broker',
  analysis: 'Analysis',
  settlement: 'Settlement',
  maintenance: 'Session Retention',
  ai: 'AI',
};

function stateText(component: string, health: string, detail: string): string {
  if (health === 'not_configured') return component === 'broker' ? 'DISABLED' : 'NOT CONFIGURED';
  if (health === 'ok' && component === 'ai') {
    return detail.toLowerCase().includes('rule-based') ? 'RULE-BASED' : 'ONLINE';
  }
  if (health === 'ok') return 'ONLINE';
  return health.toUpperCase();
}

export function SystemStrip({ status }: { status: ApiResult<SystemStatus> }) {
  if (!status.ok) {
    return (
      <Surface aria-labelledby="system-heading">
        <ModuleHeader label="Sistèm" id="system-heading" />
        <div className="px-5 py-5">
          <Dormant headline="API enjwenyab" detail={status.error} hint="npm run dev:api" hintMono />
        </div>
      </Surface>
    );
  }

  const { data } = status;

  return (
    <Surface aria-labelledby="system-heading">
      <ModuleHeader
        label="Sistèm"
        id="system-heading"
        meta={`v${data.version} · uptime ${data.uptimeSeconds}s · ${data.executionMode}`}
      />
      <ul className="grid grid-cols-2 divide-edge/70 sm:grid-cols-3 sm:divide-x lg:grid-cols-4 xl:grid-cols-8">
        {data.components.map((component) => (
          <li
            key={component.component}
            className="flex flex-col gap-2 border-b border-edge/70 px-5 py-4 last:border-b-0 sm:border-b-0"
          >
            <span className="eyebrow">{LABEL[component.component] ?? component.component}</span>
            <span className="flex items-center gap-2">
              <StatusDot health={component.health as HealthKind} />
              {/* The state is spelled out, so it never rests on colour alone. */}
              <span className="tnum text-[12px] text-text-1">
                {stateText(component.component, component.health, component.detail)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Surface>
  );
}
