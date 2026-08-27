import Link from 'next/link';
import { SettingsPanel } from '@/components/shell/SettingsPanel';
import { StatusMenu } from '@/components/shell/StatusMenu';
import type { SystemStatus } from '@binaryai/types';
import type { ApiResult, AuthContext } from '@/lib/api';
import { AccountMenu } from '@/components/auth/AccountMenu';
import { apiIndicator, marketDataIndicator, marketIndicator } from '@/lib/system-state';

/**
 * Command bar.
 *
 * Identity, the instrument in view, and operating state — readable in one
 * glance without competing with the decision below it.
 *
 * Every indicator resolves through lib/system-state, which is the only place
 * that decides what ONLINE, LOCKED, DEGRADED or NOT CONFIGURED mean. The price
 * slot stays empty unless a real current candle exists: a number here is read
 * as "the market, now", and there is no honest way to show one we do not have.
 */

/** A labelled slot in the bar. Renders an em dash when there is nothing real. */
function Slot({
  label,
  value,
  mono = true,
  tone,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  tone?: string;
}) {
  return (
    <span className="hidden min-w-0 flex-col gap-0.5 md:flex">
      <span className="telemetry-label">{label}</span>
      <span
        className={`${mono ? 'tnum' : ''} truncate text-[12px] leading-none ${tone ?? 'text-text-1'}`}
      >
        {value ?? <span className="text-text-3">—</span>}
      </span>
    </span>
  );
}

export function TopBar({
  status,
  auth,
  instrument,
  timeframe,
}: {
  status: ApiResult<SystemStatus>;
  auth: ApiResult<AuthContext>;
  /** The symbol actually in view, or null when nothing is ingested. */
  instrument: string | null;
  timeframe: string;
}) {
  const api = apiIndicator(status);
  const data = marketDataIndicator(status);
  const market = marketIndicator(status);

  return (
    <header className="sticky top-0 z-30 border-b border-edge bg-base/90 backdrop-blur-xl">
      <div className="flex h-[60px] items-center gap-4 px-4 lg:gap-5 lg:px-6">
        {/* Identity */}
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <span
            aria-hidden
            className="relative flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-gradient-to-b from-accent-strong to-accent text-[15px] leading-none font-bold text-base shadow-[0_2px_10px_-2px_rgb(139_164_255/0.5),inset_0_1px_0_0_rgb(255_255_255/0.35)]"
          >
            B
            <span
              aria-hidden
              className="absolute inset-0 rounded-[9px] ring-1 ring-white/10 ring-inset"
            />
          </span>
          {/* Name and version stacked, so the version reads as product metadata
              rather than as another value competing in the bar. */}
          <span className="flex flex-col gap-[3px] leading-none">
            <span className="text-[15px] font-semibold tracking-[-0.015em] text-text-1">
              BinaryAI
            </span>
            <span className="tnum hidden text-[9px] tracking-[0.08em] text-text-3 sm:inline">
              v0.1.0
            </span>
          </span>
        </Link>

        <span aria-hidden className="hidden h-6 w-px bg-edge md:block" />

        {/* Only the instrument. Timeframe, source and last update live in the
            market context strip directly below, and repeating them here made
            the bar read as clutter rather than as state.

            There is deliberately no price slot: BinaryAI shows a price only
            when a current candle exists, and the strip carries that. */}
        <Slot label="Instrument" value={instrument} tone="text-text-1" mono={false} />
        <span
          className="tnum hidden rounded-[5px] border border-edge bg-surface-1/70 px-2 py-1 text-[10.5px] text-text-2 xl:inline"
          title={`Timeframe ${timeframe}`}
        >
          {timeframe}
        </span>

        {/* Operating state */}
        <div className="ml-auto flex shrink-0 items-center gap-3 lg:gap-4">
          {/* One instrument cluster rather than four separate chips. */}
          <StatusMenu
            pills={[
              { label: 'API', indicator: api },
              { label: 'Data', indicator: data },
              { label: 'Market', indicator: market },
            ]}
            components={status.ok ? status.data.components : []}
          />

          {/* The demo boundary is a permanent product state, so it is given the
              weight of a control rather than the weight of a footnote. */}
          <span
            className="flex items-center gap-1.5 rounded-[6px] border border-warn/30 bg-warn/10 px-2.5 py-1.5 font-mono text-[10px] leading-none tracking-[0.14em] text-warn uppercase"
            title="Demo only. BinaryAI places no orders and connects to no broker."
          >
            <span aria-hidden className="h-[5px] w-[5px] rounded-full bg-warn" />
            demo mode
          </span>

          {auth.ok && auth.data.accountsAvailable ? (
            auth.data.user ? (
              <AccountMenu
                email={auth.data.user.email}
                role={auth.data.user.role}
                displayName={auth.data.user.displayName}
              />
            ) : (
              <Link
                href="/signin"
                className="flex h-8 items-center rounded-[6px] border border-accent/35 bg-accent-dim px-3.5 text-[12px] font-medium text-accent transition-colors hover:border-accent/55 hover:bg-accent/15"
              >
                Sign in
              </Link>
            )
          ) : null}

          <SettingsPanel signedIn={Boolean(auth.ok && auth.data.user)} />
        </div>
      </div>
    </header>
  );
}
