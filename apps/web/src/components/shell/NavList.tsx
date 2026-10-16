'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentType, SVGProps } from 'react';
import {
  IconAnalysis,
  IconLedger,
  IconOverview,
  IconPaper,
  IconPerformance,
  IconSignal,
  IconSystem,
} from '@/components/ui/icons';

/**
 * The navigation rail's links.
 *
 * Client-side only because "which item is current" is a function of the
 * pathname, and the shell is a server component. Everything else about the rail
 * stays on the server.
 *
 * `aria-current="page"` is set from the route, not from a scroll position:
 * these are destinations, and the current one is a fact about the URL rather
 * than about how far down a page the reader happens to be. `Link` gives
 * client-side navigation, so Back and Forward behave and every href is a real
 * URL that can be typed, bookmarked or refreshed.
 *
 * Labels are Haitian Creole; route paths are not. A URL is a technical
 * identifier and translating it would break every existing link and bookmark.
 */

export interface NavEntry {
  readonly label: string;
  readonly href: string;
  /** English gloss, for the tooltip on the collapsed rail. */
  readonly gloss: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
}

/**
 * Three groups, seven destinations, every one a real route.
 *
 * Grouped by the question each answers: PRINSIPAL is what the engine currently
 * thinks, TRADING is what the account has done about it, SISTÈM is whether the
 * machinery underneath is healthy.
 */
export const NAV_GROUPS: readonly { heading: string; items: readonly NavEntry[] }[] = [
  {
    heading: 'Prensipal',
    items: [
      { label: 'Apèsi', gloss: 'Overview', href: '/', icon: IconOverview },
      { label: 'Analiz', gloss: 'Analysis', href: '/analysis', icon: IconAnalysis },
      { label: 'Siyal', gloss: 'Signals', href: '/signals', icon: IconSignal },
    ],
  },
  {
    heading: 'Trading',
    items: [
      { label: 'Paper Trading', gloss: 'Paper Trading', href: '/paper-trading', icon: IconPaper },
      { label: 'Rejis', gloss: 'Ledger', href: '/ledger', icon: IconLedger },
      { label: 'Pèfòmans', gloss: 'Performance', href: '/performance', icon: IconPerformance },
    ],
  },
  {
    heading: 'Sistèm',
    items: [{ label: 'Sistèm', gloss: 'System', href: '/system', icon: IconSystem }],
  },
];

const FLAT = NAV_GROUPS.flatMap((group) => group.items);

/**
 * Is this entry the page being viewed?
 *
 * `/` matches only itself: every route starts with it, so a prefix test would
 * light up Apèsi on every page.
 */
function isCurrent(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function NavList() {
  const pathname = usePathname();

  return (
    <>
      {NAV_GROUPS.map((group) => (
        <div key={group.heading} className="flex flex-col gap-1">
          <p className="telemetry-label hidden px-3 pb-1.5 xl:block">{group.heading}</p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const Glyph = item.icon;
              const current = isCurrent(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={item.gloss}
                    {...(current ? { 'aria-current': 'page' as const } : {})}
                    className={`group relative flex items-center gap-3 rounded-[9px] px-2.5 py-[9px] text-[13px] xl:px-3 ${
                      current
                        ? 'bg-gradient-to-r from-accent/[0.14] to-accent/[0.03] font-medium text-text-1'
                        : 'text-text-3 hover:bg-surface-2/70 hover:text-text-1'
                    }`}
                  >
                    {/*
                     * The active marker: a luminous bar on the rail's inner
                     * edge. It sits OUTSIDE the item's padding so the active
                     * state reads as the rail illuminating a row, rather than
                     * as the row growing a border.
                     */}
                    <span
                      aria-hidden
                      className={`absolute top-1/2 -left-[13px] h-[20px] w-[3px] -translate-y-1/2 rounded-full bg-accent transition-all duration-200 ${
                        current
                          ? 'opacity-100 shadow-[0_0_10px_0_var(--accent)]'
                          : 'opacity-0 group-hover:opacity-40'
                      }`}
                    />
                    <Glyph
                      size={16}
                      className={
                        current
                          ? 'text-accent'
                          : 'text-text-3 transition-colors group-hover:text-text-2'
                      }
                    />
                    <span className="hidden truncate xl:inline">{item.label}</span>
                    <span className="sr-only xl:hidden">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

/** The same links as a horizontally scrolling strip, for narrow viewports. */
export function NavStrip() {
  const pathname = usePathname();

  return (
    <ul className="flex gap-1.5 overflow-x-auto px-3 py-2.5">
      {FLAT.map((item) => {
        const Glyph = item.icon;
        const current = isCurrent(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              {...(current ? { 'aria-current': 'page' as const } : {})}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] whitespace-nowrap ${
                current
                  ? 'border-accent/35 bg-accent/[0.12] font-medium text-text-1'
                  : 'border-transparent text-text-3 hover:bg-surface-2/70 hover:text-text-1'
              }`}
            >
              <Glyph size={14} className={current ? 'text-accent' : ''} />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
