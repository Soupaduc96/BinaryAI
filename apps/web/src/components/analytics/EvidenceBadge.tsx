import type { ObservedRate } from '@/lib/api';
import { Absent, Chip } from '@/components/ui/primitives';

/**
 * Shared vocabulary for rendering a measured rate.
 *
 * The rule these components exist to enforce, in the one place it can be
 * enforced: **a null rate renders as an absence, never as 0%.** Every analytics
 * surface routes through here rather than formatting a percentage itself, so no
 * component can quietly turn "no evidence" into a number.
 */

const EVIDENCE_TONE = {
  insufficient: 'neutral',
  preliminary: 'warn',
  developing: 'accent',
  established: 'bull',
} as const;

const EVIDENCE_LABEL = {
  insufficient: 'insufficient',
  preliminary: 'preliminary',
  developing: 'developing',
  established: 'established',
} as const;

/**
 * How much weight a figure can bear, always shown beside it.
 *
 * Four observations must never look as authoritative as four thousand, and the
 * only reliable way to achieve that is to put the evidence level next to the
 * number every single time.
 */
export function EvidenceBadge({ evidence }: { evidence: ObservedRate['evidence'] }) {
  return <Chip tone={EVIDENCE_TONE[evidence]}>{EVIDENCE_LABEL[evidence]}</Chip>;
}

/**
 * A rate, or an honest absence.
 *
 * Three distinct states, deliberately distinguishable at a glance:
 *
 *  - nothing settled          → em dash
 *  - settled but below policy → em dash plus the sample count, so the reader
 *                               knows data exists and why it is withheld
 *  - measured                 → the percentage
 */
export function RateValue({ rate }: { rate: ObservedRate }) {
  if (rate.value === null) {
    return (
      <span className="inline-flex items-baseline gap-1.5">
        <Absent />
        {rate.sampleSize > 0 ? (
          <span className="text-[11px] text-text-3">{rate.sampleSize} settled, below minimum</span>
        ) : null}
      </span>
    );
  }
  return <span className="tnum">{(rate.value * 100).toFixed(1)}%</span>;
}

/** Sample count with its evidence level. */
export function SampleCount({ rate }: { rate: ObservedRate }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="tnum">{rate.sampleSize.toLocaleString()}</span>
      <EvidenceBadge evidence={rate.evidence} />
    </span>
  );
}

/** Mean confidence, or an absence. Never labelled a probability. */
export function ConfidenceValue({ value }: { value: number | null }) {
  if (value === null) return <Absent />;
  return <span className="tnum">{value.toFixed(2)}</span>;
}
