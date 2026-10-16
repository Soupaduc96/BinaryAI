import { LedgerSummaryModule } from '@/components/account/AccountModules';
import { LedgerEntriesModule } from '@/components/account/LedgerEntries';
import { PaperAccountModule } from '@/components/account/PaperWorkspace';
import { WorkspaceHeader } from '@/components/shell/WorkspaceHeader';
import { fetchLedger } from '@/lib/api';
import { loadPaperContext } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * Ledger.
 *
 * Allocation and exposure at the top, then the entries those totals are made
 * of. That order is deliberate: the summary is derived from the ledger, not
 * stored alongside it, so showing the derivation under the figure is showing
 * the working.
 */
export default async function LedgerPage() {
  const [paper, ledger] = await Promise.all([loadPaperContext(), fetchLedger()]);

  return (
    <div className="flex flex-col gap-5 px-4 py-5 lg:px-6 lg:py-6">
      <WorkspaceHeader
        eyebrow="Trading"
        title="Rejis"
        lede="Kontablite ekspozisyon ki sèlman ajoute. Inite yo se yon kantite kontablite sou papye — se pa lajan ni lajan BinaryAI kenbe — epi yon retou similye se yon chif ki soti nan yon modèl ki gen non, se pa yon pwofi."
      />

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <PaperAccountModule feed={paper.paperAccount} />
        <LedgerSummaryModule account={paper.paperAccount} />
      </div>

      <LedgerEntriesModule feed={ledger} />
    </div>
  );
}
