import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Sidebar } from '@/components/shell/Sidebar';
import { TopBar } from '@/components/shell/TopBar';
import { fetchAssets, fetchAuthContext, fetchSystemStatus } from '@/lib/api';
import { marketDataIndicator } from '@/lib/system-state';
import './globals.css';

export const metadata: Metadata = {
  title: 'BinaryAI · Market Intelligence Terminal',
  description:
    'AI-assisted binary-options market analysis and decision support. Demo only: BinaryAI analyses markets and explains its reasoning; it does not place trades.',
};

/**
 * Terminal shell: command bar across the top, navigation rail on the left,
 * workspace filling the remainder.
 *
 * The status fetch is shared with the page body through React's request cache,
 * so the command bar's indicators cost no extra round trip.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  // Both are request-cached, so the page body asking for either costs nothing
  // extra. Fetched together rather than in sequence.
  const [status, auth, assets] = await Promise.all([
    fetchSystemStatus(),
    fetchAuthContext(),
    fetchAssets(),
  ]);

  // The instrument in view is whichever one BinaryAI actually holds data for.
  // Null when nothing has been ingested -- the bar shows an em dash rather than
  // a plausible-looking symbol.
  const instrument = assets.ok ? (assets.data.assets[0]?.symbol ?? null) : null;
  const data = marketDataIndicator(status);
  const integrity = {
    label: data.value === 'LIVE' ? 'Data verified' : 'No validated data',
    tone: data.value === 'LIVE' ? 'bg-bull' : 'bg-text-3',
  };

  return (
    <html lang="en">
      <body className="min-h-screen">
        <a
          href="#workspace"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:border focus:border-edge-strong focus:bg-surface-2 focus:px-4 focus:py-2 focus:text-[13px] focus:text-text-1"
        >
          Skip to workspace
        </a>

        <div className="flex min-h-screen flex-col">
          <TopBar status={status} auth={auth} instrument={instrument} timeframe="1m" />

          <div className="flex flex-1 flex-col md:flex-row">
            <Sidebar integrity={integrity} />

            <main id="workspace" className="min-w-0 flex-1">
              {children}
            </main>
          </div>

          <footer className="border-t border-edge px-4 py-5 lg:px-6">
            <p className="max-w-4xl text-[12px] leading-relaxed text-text-3">
              BinaryAI is decision-support software for market analysis. It does not place trades,
              does not connect to a broker, and makes no claim of profitability. Confidence scores
              are uncalibrated heuristics, not probabilities. Binary options carry a high risk of
              loss.
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
