import type { AnalyticsGroupFeed, ApiResult, CalibrationFeed } from '@/lib/api';
import { ConfidenceValue, EvidenceBadge, RateValue } from './EvidenceBadge';
import {
  Chip,
  DataPair,
  Dormant,
  Locked,
  ModuleHeader,
  StatRow,
  Surface,
  failureHeadline,
} from '@/components/ui/primitives';

/**
 * Calibration.
 *
 * The module's job is to make one thing unmissable: **the confidence score is
 * not a win probability.** Everything else here is secondary to that, which is
 * why the statement sits at the top rather than in a footnote.
 *
 * The bucket table is the substance — observed accuracy per confidence band —
 * and every row that lacks evidence says so rather than showing a percentage
 * that would invite comparison with the rows that have it.
 */

const RELATIONSHIP_COPY = {
  not_established: {
    label: 'Not established',
    tone: 'neutral' as const,
    detail:
      'Fewer than two confidence bands have enough settled outcomes, or observed accuracy is flat across them.',
  },
  monotonic_increasing: {
    label: 'Rises with confidence',
    tone: 'bull' as const,
    detail:
      'Observed accuracy increased across confidence bands. This describes the samples collected so far; it does not establish that the score predicts accuracy.',
  },
  monotonic_decreasing: {
    label: 'Falls with confidence',
    tone: 'bear' as const,
    detail:
      'Observed accuracy decreased as confidence rose. Worth investigating: the score may be inverted for these conditions.',
  },
  non_monotonic: {
    label: 'No consistent direction',
    tone: 'warn' as const,
    detail: 'Observed accuracy moved in both directions across confidence bands.',
  },
};

export function CalibrationModule({ feed }: { feed: ApiResult<CalibrationFeed> }) {
  if (!feed.ok) {
    return (
      <Surface aria-labelledby="calibration-heading" className="flex flex-col">
        <ModuleHeader label="Kalibrasyon" id="calibration-heading" />
        {feed.unauthorized ? (
          <Locked what="Prèv kalibrasyon an limite ak kont ou." />
        ) : (
          <div className="px-5 py-5">
            <Dormant headline={failureHeadline(feed)} detail={feed.error} />
          </div>
        )}
      </Surface>
    );
  }

  const { calibration } = feed.data;
  const relationship = RELATIONSHIP_COPY[calibration.relationship];
  const populated = calibration.buckets.filter((bucket) => bucket.counts.total > 0);

  return (
    <Surface aria-labelledby="calibration-heading" className="flex flex-col">
      <ModuleHeader
        label="Kalibrasyon"
        id="calibration-heading"
        meta={`${calibration.methodology.method} v${calibration.methodology.version}`}
        action={
          // The status that matters most, in the position the eye lands first.
          <Chip tone={calibration.implemented ? 'accent' : 'warn'}>
            {calibration.implemented ? 'model active' : 'no model'}
          </Chip>
        }
      />

      <div className="flex flex-1 flex-col gap-5 px-5 py-5">
        {/* Stated before any number, not after. */}
        <p className="rounded-[6px] border border-edge-strong bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-text-2">
          {calibration.semantics}
        </p>

        <StatRow>
          <DataPair
            label="Echantiyon eligib"
            value={calibration.eligibleSamples.toLocaleString()}
            size="lg"
          />
          <DataPair label="Eskli" value={calibration.excludedSamples.toLocaleString()} />
          <DataPair label="Prèv" value={<EvidenceBadge evidence={calibration.evidence} />} />
          <DataPair
            label="Relasyon konfyans"
            value={<Chip tone={relationship.tone}>{relationship.label}</Chip>}
          />
        </StatRow>

        <p className="text-[12px] leading-relaxed text-text-3">{relationship.detail}</p>

        {populated.length === 0 ? (
          <Dormant
            headline="Poko gen rezilta regle"
            detail={`Confidence bands populate as signals expire and settle. At least ${calibration.minimumSampleSize} settled outcomes are needed in a band before an accuracy figure is reported.`}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[340px] border-collapse text-[12px]">
              <caption className="sr-only">
                Observed accuracy by confidence band, with sample counts
              </caption>
              <thead>
                <tr className="border-b border-edge text-left">
                  <th scope="col" className="eyebrow py-2 pr-4 font-normal">
                    Band
                  </th>
                  <th scope="col" className="eyebrow py-2 pr-4 text-right font-normal">
                    Settled
                  </th>
                  <th scope="col" className="eyebrow py-2 pr-4 text-right font-normal">
                    Observed
                  </th>
                  <th scope="col" className="eyebrow py-2 text-right font-normal">
                    Mean conf.
                  </th>
                </tr>
              </thead>
              <tbody>
                {calibration.buckets.map((bucket) => {
                  const settled = bucket.counts.wins + bucket.counts.losses;
                  return (
                    <tr
                      key={bucket.id}
                      className="border-b border-edge/60 last:border-0"
                      // Empty bands are dimmed rather than hidden: their
                      // presence shows the full range was measured.
                      style={settled === 0 ? { opacity: 0.45 } : undefined}
                    >
                      <th scope="row" className="py-2.5 pr-4 text-left font-normal text-text-2">
                        <span className="tnum">{bucket.id}</span>
                      </th>
                      <td className="py-2.5 pr-4 text-right text-text-2">
                        <span className="tnum">{settled}</span>
                      </td>
                      <td className="py-2.5 pr-4 text-right text-text-1">
                        <RateValue rate={bucket.observedAccuracy} />
                      </td>
                      <td className="py-2.5 text-right text-text-2">
                        <ConfidenceValue value={bucket.meanConfidence} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {calibration.divergence !== null ? (
          <DataPair
            label="Divèjans konfyans"
            value={<span className="tnum">{calibration.divergence.toFixed(3)}</span>}
            hint="Mean gap between a band's confidence and its observed accuracy. A diagnostic, not a probabilistic calibration error."
          />
        ) : null}

        {Object.keys(calibration.exclusions).length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="eyebrow">Excluded from measurement</span>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(calibration.exclusions).map(([reason, count]) => (
                <Chip key={reason}>
                  {reason.replace(/_/g, ' ')} · {count}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5 border-t border-edge pt-4">
          <span className="eyebrow">Limitations</span>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] leading-relaxed text-text-3">
            {calibration.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      </div>
    </Surface>
  );
}

/**
 * Observed accuracy by strategy or regime.
 *
 * Shares one component because the honesty rules are identical: ordered by
 * evidence, never by accuracy, with the sample count beside every rate.
 */
export function ObservedBreakdown({
  label,
  feed,
  emptyDetail,
}: {
  label: string;
  feed: ApiResult<AnalyticsGroupFeed>;
  emptyDetail: string;
}) {
  if (!feed.ok) {
    return (
      <Surface className="flex flex-col">
        <ModuleHeader label={label} />
        {feed.unauthorized ? (
          <Locked what="Prèv pa bandwòl limite ak kont ou." />
        ) : (
          <div className="px-5 py-5">
            <Dormant headline={failureHeadline(feed)} detail={feed.error} />
          </div>
        )}
      </Surface>
    );
  }

  const { groups, ranking } = feed.data;

  return (
    <Surface className="flex flex-col">
      <ModuleHeader
        label={label}
        meta={groups.length > 0 ? `${groups.length} observed` : undefined}
      />
      <div className="flex flex-1 flex-col gap-4 px-5 py-5">
        {groups.length === 0 ? (
          <Dormant headline="Pa gen rezilta regle" detail={emptyDetail} />
        ) : (
          <>
            {/* A list, not a table. These panels sit three-up in the grid and
                are ~360px wide; a three-column table needs more than that and
                pushes the observed-accuracy column -- the whole point of the
                module -- into a horizontal scroll. */}
            <ul className="flex flex-col">
              {groups.map((group) => (
                <li
                  key={`${group.key}-${group.version ?? ''}`}
                  className="flex items-baseline justify-between gap-3 border-b border-edge/60 py-2.5 last:border-0"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[13px] text-text-2">
                      {group.key.replace(/_/g, ' ')}
                      {group.version ? (
                        <span className="tnum ml-1.5 text-[11px] text-text-3">
                          v{group.version}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-text-3">
                      <span className="tnum">
                        {group.observedAccuracy.sampleSize.toLocaleString()} settled
                      </span>
                      <EvidenceBadge evidence={group.observedAccuracy.evidence} />
                    </span>
                  </span>
                  <span className="shrink-0 text-[15px] text-text-1">
                    <RateValue rate={group.observedAccuracy} />
                  </span>
                </li>
              ))}
            </ul>
            {/* Directly under the rows it qualifies: a sorted list is exactly
                where "top of the list means best" gets assumed. */}
            <p className="text-[12px] leading-relaxed text-text-3">{ranking}</p>
          </>
        )}
      </div>
    </Surface>
  );
}
