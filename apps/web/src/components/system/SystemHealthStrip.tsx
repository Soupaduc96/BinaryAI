import type { SystemStatus } from '@binaryai/types';
import type { ApiResult } from '@/lib/api';
import { Dormant, Locked, Surface } from '@/components/ui/primitives';
import { TONE_DOT, TONE_TEXT, componentIndicator } from '@/lib/system-state';

/**
 * System health, full width and last.
 *
 * Infrastructure is present but subordinate: a user comes here to answer "is
 * something broken?", not to make a decision. A horizontal strip says that
 * better than a column module, and it leaves the workspace above to the two
 * things that matter minute to minute — the market and the decision.
 *
 * Every state comes from the API's runtime response. None is inferred from
 * whether a setting happens to be present, which is the distinction that keeps
 * NOT CONFIGURED from being confused with UNAVAILABLE.
 */

const COMPONENT_LABEL: Record<string, string> = {
  api: 'API',
  ai: 'AI',
  database: 'Database',
  rate_limiter: 'Rate limiter',
  market_data: 'Market data',
  analysis: 'Analysis',
  settlement: 'Settlement',
  // Uppercased into a narrow grid cell here: the longer "Session retention"
  // clipped to "SESSION RETENTIO…". The right-rail panel has room for it.
  maintenance: 'Maintenance',
  broker: 'Broker',
};

export function SystemHealthStrip({ status }: { status: ApiResult<SystemStatus> }) {
  if (!status.ok) {
    return (
      <Surface className="flex flex-col">
        {status.unauthorized ? (
          <Locked what="The API is running; component health requires a session." />
        ) : (
          <div className="px-5 py-5">
            <Dormant
              headline="API unreachable"
              detail={status.error}
              hint="npm run dev:api"
              hintMono
            />
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
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-5 py-3">
        <h3 className="eyebrow text-[10px]">Runtime</h3>
        <span className="flex items-center gap-3 text-[11px] text-text-3">
          <span className="tnum">v{status.data.version}</span>
          <span aria-hidden>·</span>
          <span className="tnum">uptime {uptimeLabel}</span>
          <span aria-hidden>·</span>
          {/* Stated here as well as in the top bar: the execution boundary is
              the one property that should never require hunting for. */}
          <span className="tnum text-warn">{status.data.executionMode}</span>
        </span>
      </header>

      <div className="grid grid-cols-2 divide-x divide-y divide-edge/70 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
        {status.data.components.map((component) => {
          const indicator = componentIndicator(component.health, component.detail);
          return (
            <div
              key={component.component}
              className="flex min-w-0 flex-col gap-1.5 px-4 py-3"
              title={indicator.detail}
            >
              <span className="truncate text-[10px] tracking-[0.12em] text-text-3 uppercase">
                {COMPONENT_LABEL[component.component] ?? component.component.replace(/_/g, ' ')}
              </span>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`h-[5px] w-[5px] shrink-0 rounded-full ${TONE_DOT[indicator.tone]}`}
                />
                <span className={`truncate text-[11px] font-medium ${TONE_TEXT[indicator.tone]}`}>
                  {indicator.value}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </Surface>
  );
}
