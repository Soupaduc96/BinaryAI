import { ActivePositionModule } from '@/components/account/ActivePosition';
import { RecentPositionsModule } from '@/components/account/AccountModules';
import { AccountRiskModule, PaperAccountModule } from '@/components/account/PaperWorkspace';
import { PaperSimulationModule } from '@/components/account/PaperSimulation';
import { PaperActionPanel } from '@/components/workspace/PaperActionPanel';
import { WorkspaceHeader } from '@/components/shell/WorkspaceHeader';
import { fetchRiskEvents, fetchSimulationModels } from '@/lib/api';
import { fetchActionability } from '@/lib/api-risk';
import {
  loadDecision,
  loadPaperContext,
  resolveWorkspace,
  type SearchParams,
} from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * Paper Trading.
 *
 * The whole act, in the order it happens: what may be done, doing it, what is
 * live, what has closed, and the model any simulated figure was computed under.
 *
 * Nothing about the accounting changes here — the risk policy is evaluated
 * server-side on every attempt, and this page reports its verdict rather than
 * reconstructing one from account numbers that could disagree with the policy
 * actually in force.
 */
export default async function PaperTradingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // Resolved like every other route, so the decision this page shows belongs
  // to the instrument the workspace is on.
  const context = await resolveWorkspace(await searchParams);
  const [paper, decision, riskEvents, simulationModels] = await Promise.all([
    loadPaperContext(),
    loadDecision(context),
    fetchRiskEvents(),
    fetchSimulationModels(),
  ]);

  const signalPosition =
    decision.signalId && paper.positions.ok
      ? (paper.positions.data.positions.find((entry) => entry.signalId === decision.signalId) ??
        null)
      : null;

  // Only asked when it can be answered: an accepted signal, a signed-in user,
  // and no position already open on it.
  const actionability =
    paper.signedIn &&
    decision.signalId &&
    decision.detail?.signal.status === 'accepted' &&
    !signalPosition
      ? await fetchActionability(decision.signalId)
      : null;

  return (
    <div className="flex flex-col gap-5 px-4 py-5 lg:px-6 lg:py-6">
      <WorkspaceHeader
        eyebrow="Trading"
        title="Paper trading"
        lede="Ekspozisyon similye sèlman. BinaryAI pa pase okenn lòd, li pa konekte ak okenn courtier, epi inite yo se yon kantite kontablite — se pa lajan."
      />

      <PaperActionPanel
        signalId={decision.signalId}
        signedIn={paper.signedIn}
        actionable={decision.detail?.signal.status === 'accepted'}
        direction={
          decision.detail?.signal.direction === 'call' ||
          decision.detail?.signal.direction === 'put'
            ? decision.detail.signal.direction
            : null
        }
        instrument={decision.detail?.signal.asset ?? null}
        timeframe={decision.detail?.signal.timeframe ?? null}
        expirySeconds={decision.detail?.signal.expiration.seconds ?? null}
        capacity={paper.capacity}
        model={paper.activeModel}
        actionability={actionability?.ok ? actionability.data.decision : null}
        position={signalPosition}
      />

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ActivePositionModule feed={paper.positions} model={paper.activeModel} />
        <PaperAccountModule feed={paper.paperAccount} />
      </div>

      <AccountRiskModule
        policy={paper.riskPolicy}
        account={paper.paperAccount}
        events={riskEvents}
      />

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <RecentPositionsModule feed={paper.positions} simulation={paper.simulated} />
        <PaperSimulationModule feed={paper.simulated} catalogue={simulationModels} />
      </div>
    </div>
  );
}
