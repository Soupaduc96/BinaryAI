import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import { Sidebar } from '@/components/shell/Sidebar';
import { CommandBar } from '@/components/shell/CommandBar';
import { TopBar } from '@/components/shell/TopBar';
import { DEFAULT_TIMEFRAME } from '@/lib/timeframe';
import { fetchAssets, fetchAuthContext, fetchSystemStatus } from '@/lib/api';
import { fetchInstruments } from '@/lib/api-instruments';
import { marketDataIndicator } from '@/lib/system-state';
import './globals.css';

export const metadata: Metadata = {
  title: 'BinaryAI · Sistèm Entèlijans Mache',
  description:
    'Analiz mache ak sipò desizyon pou opsyon binè, ak asistans AI. Demo sèlman: BinaryAI analize mache yo epi li eksplike rezònman li; li pa pase okenn lòd.',
  applicationName: 'BinaryAI',
  authors: [{ name: 'PAD DIGITAL LLC' }],
};

/**
 * Terminal shell: command bar across the top, navigation rail on the left,
 * workspace filling the remainder.
 *
 * The status fetch is shared with the page body through React's request cache,
 * so the command bar's indicators cost no extra round trip.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  // All request-cached, so a page body asking for any of these costs nothing
  // extra. Fetched together rather than in sequence.
  const [status, auth, assets, catalogue] = await Promise.all([
    fetchSystemStatus(),
    fetchAuthContext(),
    fetchAssets(),
    fetchInstruments(),
  ]);

  /*
   * The command bar cannot read the query string on the server, so it is handed
   * the two lists and applies `pickInstrument` — the same rule the pages use.
   *
   * Both lists are needed, not just one. `stored` supplies the DEFAULT when no
   * `?asset=` is present; the catalogue supplies the DISPLAY form and validates
   * the requested symbol. With only the stored list the bar showed an em dash
   * above a BTC-USD chart; with only the catalogue it could not know which
   * instrument a bare `/` opens on.
   */
  const instruments = catalogue.ok
    ? catalogue.data.instruments.map((entry) => ({
        symbol: entry.instrument.symbol,
        display: entry.instrument.displaySymbol,
      }))
    : [];
  const stored = assets.ok
    ? assets.data.assets.map((asset) => ({
        symbol: asset.symbol,
        display: asset.displaySymbol ?? asset.symbol,
      }))
    : [];
  const data = marketDataIndicator(status);
  const integrity = {
    label: data.value === 'LIVE' ? 'Done verifye' : 'Pa gen done verifye',
    live: data.value === 'LIVE',
  };

  return (
    <html lang="ht">
      <body className="min-h-screen">
        <a
          href="#workspace"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:border focus:border-accent/40 focus:bg-surface-3 focus:px-4 focus:py-2 focus:text-[13px] focus:text-text-1"
        >
          Ale nan espas travay la
        </a>

        <div className="flex min-h-screen flex-col">
          {/* The bar reads the instrument and timeframe from the URL rather
              than being handed them. Previously the layout resolved the
              instrument itself -- ignoring `?asset=` -- and was passed the
              literal string "1m", so at `?tf=15m` the bar said 1m while the
              chart and the context strip said 15m. */}
          {/* Suspense because CommandBar reads the query string, and the 404
              page is prerendered statically — `useSearchParams` bails out of
              static rendering without a boundary. On the dynamic routes the
              fallback is never seen; on /404 it renders the default stored
              instrument, which is what a route with no query string shows. */}
          <Suspense
            fallback={
              <TopBar
                status={status}
                auth={auth}
                instrument={(stored[0] ?? instruments[0])?.display ?? null}
                timeframe={DEFAULT_TIMEFRAME}
              />
            }
          >
            <CommandBar status={status} auth={auth} stored={stored} catalogue={instruments} />
          </Suspense>

          <div className="flex flex-1 flex-col md:flex-row">
            <Sidebar integrity={integrity} />

            <main id="workspace" className="min-w-0 flex-1">
              {children}
            </main>
          </div>

          {/*
           * The footer carries the product's boundaries, so it is given a
           * sealed surface rather than being left to float at the end of the
           * scroll. The company line sits beside the disclaimer because the
           * two answer the same question: who is telling you this, and what
           * exactly are they claiming.
           */}
          <footer className="mt-auto border-t border-edge bg-surface-1/40 px-4 py-5 lg:px-6">
            <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
              <p className="max-w-3xl text-[11.5px] leading-relaxed text-text-3">
                BinaryAI se yon lojisyèl sipò desizyon pou analiz mache. Li pa pase okenn lòd, li pa
                konekte ak okenn courtier, epi li pa pretann okenn pwofitabilite. Nòt konfyans yo se
                eristik ki pa kalibre — se pa pwobabilite. Opsyon binè gen yon gwo risk pèt.
              </p>
              <p className="flex items-center gap-2 text-[10px] leading-none tracking-[0.16em] text-text-3/70 uppercase">
                <span aria-hidden className="h-[3px] w-[3px] rounded-full bg-text-3/60" />
                PAD Digital LLC
              </p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
