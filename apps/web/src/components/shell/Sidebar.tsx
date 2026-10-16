import Link from 'next/link';
import { NavList, NavStrip } from '@/components/shell/NavList';
import { StatusMark } from '@/components/ui/status';

/**
 * The navigation rail.
 *
 * Deliberately given a DIFFERENT silhouette from the command bar above it: the
 * rail is a solid column with its own vertical brand block and a sealed footer,
 * while the bar is a thin translucent strip. Two navigation surfaces that look
 * alike is the flaw that makes most dashboards feel generic — a reader should
 * never have to work out which one they are in.
 *
 * Responsive:
 *   ≥1280px  full rail, brand lockup, group headings, integrity footer
 *   768px+   icon rail, labels exposed as accessible names and tooltips
 *   <768px   horizontal strip beneath the command bar
 *
 * Seven destinations, each a real route. Nothing here is an anchor pretending
 * to be a page.
 */

export function Sidebar({ integrity }: { integrity?: { label: string; live: boolean } }) {
  return (
    <aside
      aria-label="Navigasyon prensipal"
      className="border-b border-edge bg-surface-1/40 md:border-r md:border-b-0 md:bg-gradient-to-b md:from-surface-1/70 md:to-base/20"
    >
      {/* Desktop / tablet rail */}
      <nav className="hidden h-full flex-col md:flex xl:w-[240px]">
        {/*
         * Brand block. PAD DIGITAL LLC is the company; BinaryAI is the product,
         * and it is the larger of the two because it is the thing the reader is
         * using. The block is sealed with a hairline so the rail has a head
         * rather than starting mid-air.
         */}
        <div className="border-b border-edge px-3 py-4 xl:px-4 xl:py-5">
          <Link
            href="/"
            className="flex items-center gap-3 rounded-lg outline-offset-4"
            title="BinaryAI — PAD DIGITAL LLC"
          >
            <span
              aria-hidden
              className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-gradient-to-br from-accent-strong via-accent to-iris text-[16px] leading-none font-bold text-void shadow-[0_4px_16px_-4px_rgb(61_139_255/0.6)]"
            >
              B
              <span
                aria-hidden
                className="absolute inset-0 rounded-[11px] ring-1 ring-white/15 ring-inset"
              />
            </span>
            <span className="hidden min-w-0 flex-col gap-[3px] xl:flex">
              <span className="text-[9px] leading-none font-semibold tracking-[0.18em] text-text-3 uppercase">
                PAD Digital LLC
              </span>
              <span className="text-[16px] leading-none font-semibold tracking-[-0.02em] text-text-1">
                BinaryAI
              </span>
            </span>
          </Link>
        </div>

        <div className="flex flex-1 flex-col gap-5 px-3 py-5 xl:px-4">
          <NavList />
        </div>

        {/*
         * Footer. Two facts that hold on every route: whether the data behind
         * the interface is verified, and that nothing here places a trade.
         * Sealed with a hairline so the rail ends deliberately.
         */}
        <div className="mt-auto flex flex-col gap-2.5 border-t border-edge px-3 py-4 xl:px-4">
          {integrity ? (
            <span className="hidden items-center gap-2 xl:flex">
              <StatusMark
                kind={integrity.live ? 'live' : 'idle'}
                label={integrity.live ? 'Done verifye' : 'Pa gen done verifye'}
              />
              <span className="text-[11px] text-text-3">{integrity.label}</span>
            </span>
          ) : null}
          <p className="hidden text-[10.5px] leading-relaxed text-text-3/80 xl:block">
            Sipò desizyon sèlman. BinaryAI pa pase okenn lòd.
          </p>
        </div>
      </nav>

      {/* Mobile strip */}
      <nav className="md:hidden" aria-label="Navigasyon">
        <NavStrip />
      </nav>
    </aside>
  );
}
