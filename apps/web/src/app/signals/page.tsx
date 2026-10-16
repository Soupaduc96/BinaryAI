import { DecisionPanel } from '@/components/workspace/DecisionPanel';
import { SignalIntelligence } from '@/components/workspace/SignalIntelligence';
import { WorkspaceHeader } from '@/components/shell/WorkspaceHeader';
import { fetchPositions } from '@/lib/api';
import { loadDecision, resolveWorkspace, type SearchParams } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * Signal Intelligence.
 *
 * The record of what BinaryAI decided and why. The most recent decision leads,
 * because "what does it think right now" is the first question; the history
 * follows, because a single signal means little without the sequence it came
 * from.
 *
 * No paper action here. Acting is a different intent with different
 * consequences, and it lives in Paper Trading — a page about reading the record
 * should not put an irreversible-feeling button next to every row.
 */
export default async function SignalsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // The signal record is per instrument, so this page resolves the workspace
  // like every other route rather than reading a global feed.
  const context = await resolveWorkspace(await searchParams);
  const [decision, positions] = await Promise.all([loadDecision(context), fetchPositions()]);

  const recorded = decision.signals.ok ? decision.signals.data.total : null;

  return (
    <div className="flex flex-col gap-5 px-4 py-5 lg:px-6 lg:py-6">
      <WorkspaceHeader
        eyebrow="Prensipal"
        title="Entèlijans siyal"
        lede="Chak desizyon motè a anrejistre, ak prèv ki dèyè l. Konfyans se yon nòt eristik ki pa kalibre — se pa yon pwobabilite pou genyen."
        {...(recorded === null ? {} : { meta: `${recorded} recorded` })}
      />

      <DecisionPanel feed={decision.signals} detail={decision.detail} />

      <SignalIntelligence feed={decision.signals} positions={positions} />
    </div>
  );
}
