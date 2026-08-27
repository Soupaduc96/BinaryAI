import type { BacktestMetrics, BacktestTrade } from '@binaryai/types';
import { round, safeDivide } from '@binaryai/utils';

/**
 * Metrics are computed from the trade list alone, so they can be recomputed and
 * audited independently of the run that produced them.
 *
 * Win rate deliberately excludes unresolved trades from the denominator rather
 * than counting them as losses -- an unsettled trade is missing information,
 * not a loss, and conflating the two flatters or punishes results arbitrarily.
 */
export function computeMetrics(
  trades: readonly BacktestTrade[],
  startingBalance: number,
): BacktestMetrics {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let unresolved = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let netPnl = 0;

  let currentWinStreak = 0;
  let currentLossStreak = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;

  let peak = startingBalance;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;

  for (const trade of trades) {
    netPnl += trade.pnl;
    if (trade.pnl > 0) grossProfit += trade.pnl;
    if (trade.pnl < 0) grossLoss += -trade.pnl;

    switch (trade.outcome) {
      case 'win':
        wins += 1;
        currentWinStreak += 1;
        currentLossStreak = 0;
        break;
      case 'loss':
        losses += 1;
        currentLossStreak += 1;
        currentWinStreak = 0;
        break;
      case 'tie':
        ties += 1;
        currentWinStreak = 0;
        currentLossStreak = 0;
        break;
      case 'unresolved':
        unresolved += 1;
        break;
    }
    longestWinStreak = Math.max(longestWinStreak, currentWinStreak);
    longestLossStreak = Math.max(longestLossStreak, currentLossStreak);

    peak = Math.max(peak, trade.balanceAfter);
    const drawdown = peak - trade.balanceAfter;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPercent = safeDivide(drawdown, peak) * 100;
    }
  }

  const resolved = wins + losses;

  return {
    trades: trades.length,
    wins,
    losses,
    ties,
    unresolved,
    winRate: resolved === 0 ? null : round(wins / resolved, 6),
    lossRate: resolved === 0 ? null : round(losses / resolved, 6),
    netPnl: round(netPnl, 6),
    returnPercent: round(safeDivide(netPnl, startingBalance) * 100, 6),
    maxDrawdown: round(maxDrawdown, 6),
    maxDrawdownPercent: round(maxDrawdownPercent, 6),
    longestWinStreak,
    longestLossStreak,
    expectancyPerTrade: trades.length === 0 ? null : round(netPnl / trades.length, 6),
    profitFactor: grossLoss === 0 ? null : round(grossProfit / grossLoss, 6),
  };
}
