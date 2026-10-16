import type { InstrumentStatus } from '@binaryai/types';

/**
 * "You are looking at X. The engine analyses Y."
 *
 * The most important sentence in the multi-asset build, and the one thing that
 * could make BinaryAI actively misleading if it were wrong.
 *
 * The situation: a user selects EUR/USD. The chart fills with real, live,
 * validated EUR/USD candles. Directly beneath it the decision panel shows a
 * signal and the paper action panel offers to act on it. Nothing else on the
 * screen says which instrument those refer to, and the natural reading is that
 * they describe the chart above.
 *
 * R6 — WHY THIS TAKES A SET. It previously took ONE symbol and compared with
 * `!==`, so configuring `ANALYSIS_INSTRUMENTS=BTCUSD,ETHUSD` produced a banner
 * that said "You are viewing ETH/USD. BinaryAI analyses BTC/USD" — while ETH
 * was being analysed, on that same screen, at that same moment. A banner that
 * exists to prevent a misunderstanding cannot itself be the misunderstanding.
 *
 * It renders NOTHING when the viewed instrument IS analysed — a banner that is
 * always present is a banner nobody reads.
 *
 * It does not hide the decision panel: the signal is real and its instrument is
 * named on it. Suppressing genuine analysis to avoid a labelling problem would
 * be the wrong fix.
 */
export function AnalysisScopeNotice({
  viewing,
  analysedSymbols,
  analysedDisplays,
}: {
  /** The instrument the workspace is showing. */
  viewing: InstrumentStatus | null;
  /** Canonical symbols the engine analyses. Empty when analysis is off. */
  analysedSymbols: readonly string[];
  /** Display forms of those instruments, in the same order, where known. */
  analysedDisplays: readonly string[];
}) {
  if (!viewing) return null;

  const analysisOff = analysedSymbols.length === 0;
  const mismatch = !analysisOff && !analysedSymbols.includes(viewing.instrument.symbol);
  if (!mismatch && !analysisOff) return null;

  // Display forms when the catalogue knew them, canonical symbols otherwise.
  const named = (
    analysedDisplays.length === analysedSymbols.length ? analysedDisplays : analysedSymbols
  ).join(', ');

  return (
    <aside
      // `status`, not `alert`: this is a standing condition of the workspace,
      // not an event. `alert` would interrupt a screen reader mid-sentence
      // every time the instrument changed.
      role="status"
      className="panel panel-warn flex items-start gap-3 px-4 py-3"
    >
      <span aria-hidden className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full bg-warn" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-[12.5px] leading-relaxed text-text-1">
          {analysisOff ? (
            <>
              Analiz motè a pa konfigire nan deplwaman sa a. Graf la ak done mache pou{' '}
              <strong className="font-medium">{viewing.instrument.displaySymbol}</strong> se done
              reyèl; men pa gen okenn siyal k ap pwodwi pou okenn enstriman.
            </>
          ) : (
            <>
              W ap gade <strong className="font-medium">{viewing.instrument.displaySymbol}</strong>.
              BinaryAI analize <strong className="font-medium">{named}</strong>, kidonk chak siyal,
              evalyasyon risk ak aksyon papye sou paj sa a refere a{' '}
              {analysedSymbols.length === 1 ? named : 'enstriman sa yo'} — pa a graf ki anwo a.
            </>
          )}
        </p>
        <p className="text-[11px] leading-relaxed text-text-3">
          {viewing.availability.marketData.state === 'available'
            ? 'Done mache ak grafik yo se pa enstriman. Analiz motè a kouri sou ansanm sèvè a konfigire a.'
            : viewing.availability.marketData.detail}
        </p>
      </div>
    </aside>
  );
}
