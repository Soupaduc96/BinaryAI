/**
 * @binaryai/backtest -- historical simulation and paper trading.
 *
 * Both run the live decision pipeline from @binaryai/engine. Results are always
 * stamped `resultType: 'historical_simulation'` and carry the disclaimer from
 * @binaryai/types; nothing here may be presented as real trading performance.
 */

export {
  runBacktest,
  DEFAULT_PAYOUT_MODEL,
  DEFAULT_STAKE_MODEL,
  type BacktestRequest,
} from './runner.js';
export { computeMetrics } from './metrics.js';
export {
  createPaperAccount,
  openPaperPosition,
  settlePaperPosition,
  cancelPaperPosition,
  PaperTradingError,
  type CreatePaperAccountOptions,
  type OpenPositionRequest,
} from './paper-account.js';
