'use client';

import { useSearchParams } from 'next/navigation';
import type { SystemStatus } from '@binaryai/types';
import type { ApiResult, AuthContext } from '@/lib/api';
import { TopBar } from '@/components/shell/TopBar';
import { DEFAULT_TIMEFRAME, readTimeframe } from '@/lib/timeframe';
import { pickInstrument, type SelectableInstrument } from '@/lib/instrument-select';

/**
 * Reads the instrument and timeframe out of the URL for the command bar.
 *
 * The layout is a server component and cannot see `?asset=` or `?tf=` — Next
 * gives search params to pages, not layouts. Previously it worked around that
 * by resolving the instrument itself from the asset list (ignoring `?asset=`)
 * and by passing the literal string `"1m"` as the timeframe. Both were wrong in
 * the same way: at `?tf=15m&asset=ETHUSD` the bar disagreed with the chart
 * directly beneath it.
 *
 * A thin client wrapper is the smallest honest fix: one hook, no extra fetch,
 * and the bar reports the state the workspace is actually in.
 *
 * Resolution is delegated to `pickInstrument`, the same function the server
 * uses. The bar cannot drift from the page because there is only one rule.
 */
export function CommandBar({
  status,
  auth,
  stored,
  catalogue,
}: {
  status: ApiResult<SystemStatus>;
  auth: ApiResult<AuthContext>;
  /** Instruments BinaryAI holds candles for, in the server's order. */
  stored: readonly SelectableInstrument[];
  /** The server-defined catalogue, for display forms and validation. */
  catalogue: readonly SelectableInstrument[];
}) {
  const params = useSearchParams();
  const timeframe = params.get('tf');

  const instrument = pickInstrument(params.get('asset'), stored, catalogue);

  return (
    <TopBar
      status={status}
      auth={auth}
      // The DISPLAY form: the bar is presentation, and BTC/USD is what the
      // rest of the interface calls this instrument.
      instrument={instrument?.display ?? null}
      timeframe={timeframe ? readTimeframe(timeframe) : DEFAULT_TIMEFRAME}
    />
  );
}
