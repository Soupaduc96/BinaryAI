#!/usr/bin/env node
/**
 * Demo backtest.
 *
 * Runs a registered strategy over a SYNTHETIC dataset so the engine can be
 * exercised end to end without a market-data provider. The output is a
 * statement about the engine, not about the strategy's edge -- a random walk
 * has no edge to find, which is exactly why it is safe to ship as a demo.
 *
 *   npm run backtest:demo
 *   node scripts/run-backtest.mjs --strategy mean-reversion --candles 800 --seed 7
 */

import { runBacktest, DEFAULT_PAYOUT_MODEL } from '@binaryai/backtest';
import { createSyntheticSeries, defaultTestAsset } from '@binaryai/fixtures';
import { createDefaultRegistry } from '@binaryai/strategies';

function parseArgs(argv) {
  // Drift defaults to ZERO on purpose. A synthetic series with drift is a
  // one-way market, and a trend-follower "wins" ~99% of the time on it -- a
  // number that means nothing and looks like a performance claim. A driftless
  // random walk is the honest demo: it shows the engine working, and it shows
  // that a coin flip loses money against an 80% payout.
  const args = { strategy: 'trend-momentum', candles: 600, seed: 42, drift: 0, expiry: 180 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === '--strategy') args.strategy = value;
    if (key === '--candles') args.candles = Number(value);
    if (key === '--seed') args.seed = Number(value);
    if (key === '--drift') args.drift = Number(value);
    if (key === '--expiry') args.expiry = Number(value);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const registry = createDefaultRegistry();

if (!registry.has(args.strategy)) {
  console.error(
    `Unknown strategy "${args.strategy}". Registered: ${registry
      .describe()
      .map((meta) => meta.id)
      .join(', ')}`,
  );
  process.exit(1);
}

const strategy = registry.get(args.strategy);
const series = createSyntheticSeries({
  count: args.candles,
  seed: args.seed,
  drift: args.drift,
  volatility: 0.0006,
  timeframe: '1m',
});

const result = runBacktest({
  asset: defaultTestAsset,
  series,
  strategy,
  config: {
    strategyId: strategy.meta.id,
    parameters: {},
    expirationSeconds: args.expiry,
    payout: DEFAULT_PAYOUT_MODEL,
    stake: { kind: 'fixed', value: 10 },
    startingBalance: 1000,
    warmupBars: 60,
    minConfidence: 0.6,
  },
});

const { metrics, dataset } = result;
const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);

console.log('');
console.log('BinaryAI :: historical simulation');
console.log('='.repeat(64));
line('Strategy', `${result.strategy.name} v${result.strategy.version}`);
line('Dataset', dataset.label);
line('Candles', `${dataset.candleCount} x ${dataset.timeframe}`);
line('Payout assumption', DEFAULT_PAYOUT_MODEL.note);
console.log('-'.repeat(64));
line('Trades', metrics.trades);
line('Wins / losses / ties', `${metrics.wins} / ${metrics.losses} / ${metrics.ties}`);
line(
  'Win rate',
  metrics.winRate === null ? 'n/a (no resolved trades)' : `${(metrics.winRate * 100).toFixed(2)}%`,
);
line('Net PnL', metrics.netPnl.toFixed(2));
line('Return', `${metrics.returnPercent.toFixed(2)}%`);
line(
  'Max drawdown',
  `${metrics.maxDrawdown.toFixed(2)} (${metrics.maxDrawdownPercent.toFixed(2)}%)`,
);
line('Longest win streak', metrics.longestWinStreak);
line('Longest loss streak', metrics.longestLossStreak);
line(
  'Expectancy / trade',
  metrics.expectancyPerTrade === null ? 'n/a' : metrics.expectancyPerTrade.toFixed(4),
);
line('Profit factor', metrics.profitFactor === null ? 'n/a' : metrics.profitFactor.toFixed(3));
console.log('-'.repeat(64));
for (const warning of result.warnings) console.log(`  ! ${warning}`);
if (args.drift !== 0) {
  console.log(
    `  ! drift=${args.drift} generates a one-way market. A trend-following result on it is an\n` +
      '    artifact of the generator, not an edge. Do not read the win rate as performance.',
  );
}
console.log('');
console.log(`  ${result.disclaimer}`);
console.log('');
