import type { Capability, CapabilityState, InstrumentStatus } from '@binaryai/types';
import type { ProviderCapabilities } from '@binaryai/types';

/**
 * What BinaryAI can actually do with the instrument in view.
 *
 * This panel exists because of one specific way the product could mislead:
 * a real, live, validated chart for EUR/USD looks exactly like a real, live,
 * validated chart for the instrument the engine actually analyses. Nothing on
 * screen distinguishes them, and the natural reading of "there is a chart" is
 * "the system has an opinion about this".
 *
 * So the four capabilities are stated separately and never collapsed:
 *
 *   MARKET DATA    a provider serves it
 *   CHART          validated candles are stored
 *   ENGINE         the engine analyses THIS instrument
 *   PAPER TRADING  a signal exists that can be acted on
 *
 * Each carries the reason it is in the state it is in. "Not configured" and
 * "No data" have different fixes, and a shared "Unavailable" would hide which.
 */

const TONE: Record<CapabilityState, { label: string; dot: string; text: string }> = {
  available: { label: 'Available', dot: 'bg-bull', text: 'text-bull' },
  not_configured: { label: 'Not configured', dot: 'bg-text-3', text: 'text-text-3' },
  unsupported: { label: 'Unsupported', dot: 'bg-text-3', text: 'text-text-3' },
  no_data: { label: 'No data', dot: 'bg-warn', text: 'text-warn' },
  provider_error: { label: 'Provider error', dot: 'bg-bear', text: 'text-bear' },
  rate_limited: { label: 'Rate limited', dot: 'bg-warn', text: 'text-warn' },
};

export function InstrumentContext({
  entry,
  provider,
  assetClassLabel,
}: {
  entry: InstrumentStatus;
  /** Capabilities of the provider serving this instrument's class, if any. */
  provider: ProviderCapabilities | null;
  assetClassLabel: string;
}) {
  const { instrument, availability } = entry;

  return (
    <section
      aria-label={`What BinaryAI can do with ${instrument.displaySymbol}`}
      className="panel divide-y divide-edge"
    >
      {/* ------------------------------------------------ identity strip -- */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 px-4 py-3.5 sm:grid-cols-4">
        <Field label="Klas aktif" value={assetClassLabel} />
        <Field label="Enstriman" value={instrument.displaySymbol} title={instrument.name} />
        <Field
          label="Kote an"
          value={instrument.quoting.quote}
          hint={`${instrument.quoting.pricePrecision} dp`}
        />
        <Field
          label="Sous done"
          value={provider?.displayName ?? 'None'}
          hint={provider ? provider.dataOrigin : undefined}
        />
      </div>

      {/* ------------------------------------------------- capabilities -- */}
      <ul className="grid grid-cols-1 divide-y divide-edge sm:grid-cols-2 sm:divide-y-0 sm:divide-x">
        <CapabilityRow label="Done mache" capability={availability.marketData} />
        <CapabilityRow label="Graf" capability={availability.chart} />
      </ul>
      <ul className="grid grid-cols-1 divide-y divide-edge sm:grid-cols-2 sm:divide-y-0 sm:divide-x">
        <CapabilityRow label="Analiz motè" capability={availability.analysis} />
        <CapabilityRow label="Paper trading" capability={availability.paperTrading} />
      </ul>

      {/*
        The provider's own stated limitations, verbatim.

        Shown rather than summarised because the caveats that matter are
        specific: an undocumented endpoint with no SLA, and commodity
        instruments that are front-month futures rather than spot. A reader who
        assumes GC=F is spot gold is wrong about a real number.
      */}
      {provider && provider.limitations.length > 0 ? (
        <details className="group px-4 py-2.5">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] text-text-3 hover:text-text-2">
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="h-3 w-3 transition-transform group-open:rotate-90"
            >
              <path
                d="M6 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {provider.displayName} — what this data is, and is not
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5 pl-5">
            {provider.limitations.map((limitation) => (
              <li
                key={limitation}
                className="list-disc text-[11.5px] leading-relaxed text-text-3 marker:text-text-3/50"
              >
                {limitation}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function Field({
  label,
  value,
  hint,
  title,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  title?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="telemetry-label">{label}</span>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span
          title={title}
          className="tnum truncate text-[13.5px] leading-none font-medium text-text-1"
        >
          {value}
        </span>
        {hint ? <span className="shrink-0 text-[10px] text-text-3">{hint}</span> : null}
      </span>
    </div>
  );
}

/**
 * One capability, with its cause.
 *
 * The detail line is always rendered, not only on failure. An operator reading
 * "Available — Coinbase Exchange serves BTC/USD at 1m, 5m…" learns something
 * a bare green dot does not tell them, and the layout does not shift when a
 * state changes.
 */
function CapabilityRow({ label, capability }: { label: string; capability: Capability }) {
  const tone = TONE[capability.state];
  return (
    <li className="flex min-w-0 flex-col gap-1.5 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="telemetry-label">{label}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span aria-hidden className={`h-[5px] w-[5px] rounded-full ${tone.dot}`} />
          <span className={`text-[10.5px] tracking-[0.07em] uppercase ${tone.text}`}>
            {tone.label}
          </span>
        </span>
      </div>
      <p className="text-[11.5px] leading-relaxed text-text-3">{capability.detail}</p>
    </li>
  );
}
