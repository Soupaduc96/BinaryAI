import Link from 'next/link';
import { SettingsPanel } from '@/components/shell/SettingsPanel';
import { StatusMenu } from '@/components/shell/StatusMenu';
import type { SystemStatus } from '@binaryai/types';
import type { ApiResult, AuthContext } from '@/lib/api';
import { AccountMenu } from '@/components/auth/AccountMenu';
import { apiIndicator, marketDataIndicator, marketIndicator } from '@/lib/system-state';

/**
 * The command bar.
 *
 * An AI command centre rather than a SaaS navbar: what is in view, what state
 * the machine is in, and who is operating it — readable in one glance, and
 * never competing with the decision below.
 *
 * Given a different silhouette from the rail on purpose. This is a thin,
 * translucent strip that the workspace scrolls beneath; the rail is a solid
 * column. Two navigation surfaces that look alike is what makes a product feel
 * generic.
 *
 * Every indicator resolves through `lib/system-state`, the only place that
 * decides what ONLINE, LOCKED, DEGRADED or NOT CONFIGURED mean. There is
 * deliberately no price slot: a number here would be read as "the market, now",
 * and there is no honest way to show one we do not have.
 */

/** A labelled slot. Renders an em dash when there is nothing real to show. */
function Slot({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <span className="hidden min-w-0 flex-col gap-[5px] md:flex">
      <span className="telemetry-label">{label}</span>
      <span className={`${mono ? 'tnum' : ''} truncate text-[12.5px] leading-none text-text-1`}>
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
    <header className="sticky top-0 z-30 border-b border-edge bg-base/80 backdrop-blur-2xl">
      {/* A hairline of accent light along the bottom edge: the bar reads as lit
          rather than as outlined, and it separates from the workspace without
          a heavier border. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-accent/25 to-transparent"
      />

      <div className="flex h-[62px] items-center gap-4 px-4 lg:gap-5 lg:px-6">
        {/*
         * Compact identity, shown only where the rail's brand block is hidden.
         * Repeating the lockup beside the rail on a wide screen is the kind of
         * duplication that makes a header feel padded rather than composed.
         */}
        <Link href="/" className="flex shrink-0 items-center gap-2.5 md:hidden">
          <span
            aria-hidden
            className="relative flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-gradient-to-br from-accent-strong via-accent to-iris text-[15px] leading-none font-bold text-void"
          >
            B
          </span>
          <span className="flex flex-col gap-[3px] leading-none">
            <span className="text-[8.5px] font-semibold tracking-[0.16em] text-text-3 uppercase">
              PAD Digital
            </span>
            <span className="text-[14px] font-semibold tracking-[-0.015em] text-text-1">
              BinaryAI
            </span>
          </span>
        </Link>

        {/*
         * What is in view. The instrument and its timeframe are the two facts
         * that change what every other panel means, so they lead the bar.
         */}
        <Slot label="Enstriman" value={instrument} mono={false} />
        <span
          className="tnum hidden rounded-md border border-edge bg-surface-2/70 px-2 py-1 text-[10.5px] text-text-2 xl:inline"
          title={`Entèval ${timeframe}`}
        >
          {timeframe}
        </span>

        {/* Operating state */}
        <div className="ml-auto flex shrink-0 items-center gap-2.5 lg:gap-3">
          <StatusMenu
            pills={[
              { label: 'API', indicator: api },
              { label: 'Done', indicator: data },
              { label: 'Mache', indicator: market },
            ]}
            components={status.ok ? status.data.components : []}
          />

          {/* The demo boundary is a permanent product state, so it carries the
              weight of a control rather than of a footnote. */}
          <span
            className="hidden items-center gap-1.5 rounded-md border border-warn/30 bg-warn/[0.08] px-2.5 py-1.5 font-mono text-[9.5px] leading-none tracking-[0.14em] text-warn uppercase sm:flex"
            title="Demo sèlman. BinaryAI pa pase okenn lòd epi li pa konekte ak okenn courtier."
          >
            <span aria-hidden className="h-[5px] w-[5px] rounded-full bg-warn" />
            mòd demo
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
                className="flex h-8 items-center rounded-lg border border-accent/40 bg-accent/[0.12] px-3.5 text-[12px] font-medium text-accent hover:border-accent/60 hover:bg-accent/[0.18]"
              >
                Konekte
              </Link>
            )
          ) : null}

          <SettingsPanel signedIn={Boolean(auth.ok && auth.data.user)} />
        </div>
      </div>
    </header>
  );
}
