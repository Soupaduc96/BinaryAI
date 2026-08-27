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
 * Responsive without client state, which is why it is a server component:
 *   ≥1280px  full rail with group headings
 *   768px+   icon rail, labels via accessible name
 *   <768px   horizontal strip under the command bar
 *
 * The honesty rule here is unusual for navigation but matters: **an item that
 * leads nowhere is rendered as disabled, never as a link.** Most of this
 * product's surface is one workspace; shipping a rail full of plausible links
 * that silently do nothing would be the clearest possible example of a control
 * that looks functional and is not. Each carries a title saying so.
 */

interface NavItem {
  readonly label: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
  readonly active: boolean;
  /** Set when the destination exists today. */
  readonly href?: string;
}

interface NavGroup {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

const GROUPS: readonly NavGroup[] = [
  {
    heading: 'Intelligence',
    items: [
      { label: 'Overview', icon: IconOverview, active: true, href: '/' },
      { label: 'Analysis', icon: IconAnalysis, active: false },
      { label: 'Signals', icon: IconSignal, active: false },
      { label: 'Interpretation', icon: IconInterpretation, active: false },
    ],
  },
  {
    heading: 'Strategies',
    items: [
      { label: 'Strategies', icon: IconStrategies, active: false },
      { label: 'Backtesting', icon: IconBacktest, active: false },
    ],
  },
  {
    heading: 'Risk',
    items: [
      { label: 'Risk Dashboard', icon: IconRisk, active: false },
      { label: 'Limits', icon: IconLimits, active: false },
    ],
  },
  {
    heading: 'Account',
    items: [
      { label: 'Paper Trading', icon: IconPaper, active: false },
      { label: 'Ledger', icon: IconLedger, active: false },
    ],
  },
  {
    heading: 'Analytics',
    items: [
      { label: 'Performance', icon: IconPerformance, active: false },
      { label: 'Calibration', icon: IconCalibration, active: false },
    ],
  },
  {
    heading: 'System',
    // 'Settings' was removed: no settings capability exists, and a nav item for
    // one is a promise the product does not keep. Every remaining item names a
    // section that genuinely exists in the workspace.
    items: [{ label: 'System', icon: IconSystem, active: false }],
  },
];

function NavEntry({ item }: { item: NavItem }) {
  const Glyph = item.icon;

  const shared =
    'group relative flex items-center gap-3 rounded-[7px] px-2.5 py-2 text-[12.5px] transition-colors duration-150 xl:px-3';

  if (item.active) {
    return (
      <li>
        <span
          aria-current="page"
          className={`${shared} bg-accent/[0.07] font-medium text-text-1`}
          title={item.label}
        >
          <span
            aria-hidden
            className="absolute top-1/2 -left-[10px] h-[18px] w-[2px] -translate-y-1/2 rounded-full bg-accent"
          />
          <Glyph size={16} className="text-accent" />
          <span className="hidden truncate xl:inline">{item.label}</span>
          <span className="sr-only xl:hidden">{item.label}</span>
        </span>
      </li>
    );
  }

  /**
   * An item with no destination.
   *
   * Two things were wrong here and both were invisible from the source:
   *
   *  - It carried `hover:bg-surface-2/50 hover:text-text-2`. A background that
   *    lights up under the cursor is the strongest "click me" signal a rail
   *    has, so the item advertised itself as navigation and then did nothing.
   *    `cursor-not-allowed` arrives too late to undo that invitation.
   *  - It carried `aria-disabled` on a bare `<span>`. That attribute only
   *    applies to elements with a widget role, so a screen reader announced
   *    the label with no hint that it leads nowhere — the sighted cue (dimmed
   *    text) had no spoken equivalent.
   *
   * Now: no hover response at all, and the state is stated in text that
   * assistive technology reads, which is the same information the dimming
   * conveys visually.
   */
  return (
    <li>
      <span
        title={`${item.label} — not implemented yet`}
        className={`${shared} cursor-default text-text-3/60`}
      >
        <Glyph size={16} className="opacity-60" />
        <span className="hidden truncate xl:inline">{item.label}</span>
        <span className="sr-only xl:hidden">{item.label}</span>
        <span className="sr-only"> — not implemented yet</span>
      </span>
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
                {/* Same reasoning as the rail above: no `aria-disabled` on a
                    role-less span, and the unavailability is spoken rather than
                    only dimmed. */}
                <span
                  aria-current={item.active ? 'page' : undefined}
                  title={item.active ? undefined : `${item.label} — not implemented yet`}
                  className={`flex items-center gap-2 rounded-[7px] px-3 py-1.5 text-[12px] whitespace-nowrap ${
                    item.active
                      ? 'bg-accent/10 font-medium text-text-1'
                      : 'cursor-default text-text-3/60'
                  }`}
                >
                  <Glyph size={14} className={item.active ? 'text-accent' : 'opacity-60'} />
                  {item.label}
                  {item.active ? null : <span className="sr-only"> — not implemented yet</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
