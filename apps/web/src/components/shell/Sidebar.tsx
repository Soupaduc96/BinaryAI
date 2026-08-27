import type { ComponentType, SVGProps } from 'react';
import {
  IconAnalysis,
  IconBacktest,
  IconCalibration,
  IconInterpretation,
  IconLedger,
  IconLimits,
  IconOverview,
  IconPaper,
  IconPerformance,
  IconRisk,
  IconSignal,
  IconStrategies,
  IconSystem,
} from '@/components/ui/icons';

/**
 * Terminal navigation rail.
 *
 * Responsive without client state for layout:
 *   ≥1280px  full rail with group headings
 *   768px+   icon rail, labels via accessible name
 *   <768px   horizontal strip under the command bar
 *
 * **Every item is a real link to a section that exists.** They were previously
 * inert spans carrying "not implemented yet", which was truthful and useless:
 * thirteen things that look like navigation and refuse to navigate is a defect
 * however carefully it is labelled.
 *
 * The product is one workspace, so these are in-page anchors rather than
 * routes. That is the honest shape — inventing thirteen routes to make the rail
 * look like a bigger application would be the fake version of this fix. Each
 * href names an element the page actually renders, and `ActiveSection` marks
 * whichever is on screen with `aria-current`.
 */

interface NavItem {
  readonly label: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
  /**
   * The section this item reveals. Every one names an element that genuinely
   * exists on the workspace — no route is invented to make the rail look busy.
   */
  readonly href: string;
}

interface NavGroup {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

const GROUPS: readonly NavGroup[] = [
  {
    heading: 'Intelligence',
    items: [
      { label: 'Overview', icon: IconOverview, href: '#workspace' },
      { label: 'Analysis', icon: IconAnalysis, href: '#section-analysis' },
      { label: 'Signals', icon: IconSignal, href: '#section-signals' },
      { label: 'Interpretation', icon: IconInterpretation, href: '#section-decision' },
    ],
  },
  {
    heading: 'Strategies',
    items: [
      { label: 'Strategies', icon: IconStrategies, href: '#strategies-heading' },
      { label: 'Backtesting', icon: IconBacktest, href: '#backtest-heading' },
    ],
  },
  {
    heading: 'Risk',
    items: [
      { label: 'Risk Dashboard', icon: IconRisk, href: '#section-decision' },
      { label: 'Limits', icon: IconLimits, href: '#account-risk-heading' },
    ],
  },
  {
    heading: 'Account',
    items: [
      { label: 'Paper Trading', icon: IconPaper, href: '#section-action' },
      { label: 'Ledger', icon: IconLedger, href: '#section-ledger' },
    ],
  },
  {
    heading: 'Analytics',
    items: [
      { label: 'Performance', icon: IconPerformance, href: '#performance-heading' },
      { label: 'Calibration', icon: IconCalibration, href: '#calibration-heading' },
    ],
  },
  {
    heading: 'System',
    items: [{ label: 'System', icon: IconSystem, href: '#system-heading' }],
  },
];

function NavEntry({ item }: { item: NavItem }) {
  const Glyph = item.icon;

  return (
    <li>
      <a
        href={item.href}
        data-nav-target={item.href}
        className="group relative flex items-center gap-3 rounded-[7px] px-2.5 py-2 text-[12.5px] text-text-3 transition-colors duration-150 hover:bg-surface-2/60 hover:text-text-1 aria-[current=true]:bg-accent/[0.07] aria-[current=true]:font-medium aria-[current=true]:text-text-1 xl:px-3"
      >
        {/* The accent rule only appears on the current section. */}
        <span
          aria-hidden
          className="absolute top-1/2 -left-[10px] h-[18px] w-[2px] -translate-y-1/2 rounded-full bg-accent opacity-0 group-aria-[current=true]:opacity-100"
        />
        <Glyph size={16} className="group-aria-[current=true]:text-accent" />
        <span className="hidden truncate xl:inline">{item.label}</span>
        <span className="sr-only xl:hidden">{item.label}</span>
      </a>
    </li>
  );
}

export function Sidebar({ integrity }: { integrity?: { label: string; tone: string } }) {
  return (
    <aside
      aria-label="Primary"
      className="border-b border-edge bg-surface-1/40 md:border-r md:border-b-0 md:bg-transparent"
    >
      {/* Desktop / tablet rail */}
      <nav className="hidden h-full flex-col gap-6 px-3 py-5 md:flex xl:w-[224px] xl:px-4">
        {GROUPS.map((group) => (
          <div key={group.heading} className="flex flex-col gap-1.5">
            <p className="telemetry-label hidden px-3 pb-0.5 xl:block">{group.heading}</p>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavEntry key={item.label} item={item} />
              ))}
            </ul>
          </div>
        ))}

        <div className="mt-auto flex flex-col gap-3 border-t border-edge pt-4">
          {integrity ? (
            <span className="hidden items-center gap-2 px-3 xl:flex" title="Data integrity">
              <span aria-hidden className={`h-[6px] w-[6px] rounded-full ${integrity.tone}`} />
              <span className="text-[11px] text-text-3">{integrity.label}</span>
            </span>
          ) : null}
          <p className="hidden px-3 text-[11px] leading-relaxed text-text-3 xl:block">
            Decision support only. BinaryAI places no trades.
          </p>
        </div>
      </nav>

      {/* Mobile strip */}
      <nav className="md:hidden">
        {/* `relative` is load-bearing, not decorative.
            The items carry a `sr-only` span, which is `position: absolute`.
            Absolute positioning resolves against the nearest POSITIONED
            ancestor — with none, these resolved against the page and kept their
            static x, roughly 1200px along this horizontally scrolling strip.
            A 1px box sitting at x≈1280 still extends the document's scroll
            width, so the whole page scrolled sideways at 390px even though the
            strip itself was correctly clipped. Making this element the
            containing block keeps them inside the scroller. */}
        <ul className="relative flex gap-1 overflow-x-auto px-3 py-2">
          {GROUPS.flatMap((group) => group.items).map((item) => {
            const Glyph = item.icon;
            return (
              <li key={item.label}>
                <a
                  href={item.href}
                  data-nav-target={item.href}
                  className="flex items-center gap-2 rounded-[7px] px-3 py-1.5 text-[12px] whitespace-nowrap text-text-3 transition-colors hover:bg-surface-2/60 hover:text-text-1 aria-[current=true]:bg-accent/10 aria-[current=true]:font-medium aria-[current=true]:text-text-1"
                >
                  <Glyph size={14} className="group-aria-[current=true]:text-accent" />
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
