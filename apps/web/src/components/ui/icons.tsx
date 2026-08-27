import type { SVGProps } from 'react';

/**
 * Icon set.
 *
 * Hand-drawn rather than pulled from a library: seven navigation glyphs and a
 * handful of controls do not justify a dependency, and drawing them keeps the
 * stroke weight, terminal, and optical size consistent with the type scale.
 *
 * All icons share a 16px grid, 1.5 stroke, round caps, and inherit currentColor.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Overview — a workspace split into panes. */
export const IconOverview = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2" y="2.5" width="5" height="11" rx="1" />
    <rect x="9" y="2.5" width="5" height="5" rx="1" />
    <rect x="9" y="9.5" width="5" height="4" rx="1" />
  </Icon>
);

/** Analysis — a price trace. */
export const IconAnalysis = (props: IconProps) => (
  <Icon {...props}>
    <path d="M1.5 11.5 5 7l3 3 5.5-6.5" />
    <path d="M13.5 3.5v3.5M13.5 3.5H10" />
  </Icon>
);

/** Strategies — stacked rule sets. */
export const IconStrategies = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 1.75 14.5 5 8 8.25 1.5 5 8 1.75Z" />
    <path d="M1.5 8.5 8 11.75 14.5 8.5" />
    <path d="M1.5 11.75 8 15 14.5 11.75" />
  </Icon>
);

/** Backtesting — replaying history. */
export const IconBacktest = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 8a5.5 5.5 0 1 0 1.7-3.97" />
    <path d="M2 2.5V6h3.5" />
    <path d="M8 5.5V8l1.75 1.25" />
  </Icon>
);

/** Risk — a shield, not a warning triangle. Risk is managed, not alarming. */
export const IconRisk = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 1.75 13.25 4v4c0 3.1-2.2 5.35-5.25 6.25C4.95 13.35 2.75 11.1 2.75 8V4L8 1.75Z" />
    <path d="M8 6v2.75" />
    <path d="M8 10.75v.01" />
  </Icon>
);

/** Performance — measured outcomes. */
export const IconPerformance = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2 14h12" />
    <path d="M4 14V9.5M8 14V4M12 14v-6.5" />
  </Icon>
);

/** System — infrastructure. */
export const IconSystem = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
    <rect x="2" y="9" width="12" height="4.5" rx="1" />
    <path d="M4.5 4.75v.01M4.5 11.25v.01" />
  </Icon>
);

export const IconChevron = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.5 6.25 8 9.75l3.5-3.5" />
  </Icon>
);

export const IconSettings = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2 4.5h8M12.5 4.5H14" />
    <path d="M2 11.5h1.5M6 11.5h8" />
    <circle cx="11" cy="4.5" r="1.75" />
    <circle cx="4.75" cy="11.5" r="1.75" />
  </Icon>
);

export const IconMenu = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2 4h12M2 8h12M2 12h12" />
  </Icon>
);

export const IconClose = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" />
  </Icon>
);

export const IconExpand = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 2H2v4M10 14h4v-4M2 10v4h4M14 6V2h-4" />
  </Icon>
);

export const IconLayers = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 8 8 11l5.5-3" />
    <path d="M2.5 11 8 14l5.5-3" />
    <path d="M8 2 2.5 5 8 8l5.5-3L8 2Z" />
  </Icon>
);

export const IconIndicator = (props: IconProps) => (
  <Icon {...props}>
    <path d="M1.5 8h2.5l1.75-4.5L8 12.5l1.75-6L11.5 8h3" />
  </Icon>
);

/** Signals — discrete marks on a timeline. */
export const IconSignal = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2 13.5h12" />
    <path d="M4.5 13.5V9M8 13.5V4.5M11.5 13.5V7" />
  </Icon>
);

/** Interpretation — reasoning about a reading. */
export const IconInterpretation = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="6.5" r="4" />
    <path d="M6.5 13.5h3M7 11.5h2" />
  </Icon>
);

/** Limits — a bounded range. */
export const IconLimits = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 3v10M13.5 3v10" />
    <path d="M5 8h6" />
    <path d="M9.5 6.5 11 8l-1.5 1.5" />
  </Icon>
);

/** Paper trading — a sheet, deliberately not a banknote. */
export const IconPaper = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 2.5h6L12.5 5.5v8h-9z" />
    <path d="M9.5 2.5v3h3" />
    <path d="M6 9h4M6 11h2.5" />
  </Icon>
);

/** Ledger — stacked entries. */
export const IconLedger = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2.5" y="3" width="11" height="10" rx="1" />
    <path d="M2.5 6.5h11M6 6.5V13" />
  </Icon>
);

/** Calibration — a gauge being adjusted. */
export const IconCalibration = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" />
    <path d="M8 11.5 10.5 7" />
  </Icon>
);
