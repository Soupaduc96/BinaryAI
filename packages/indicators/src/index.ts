/**
 * @binaryai/indicators -- pure technical-analysis functions.
 *
 * Zero dependencies, zero I/O, fully deterministic. This package is the one
 * place indicator maths lives: live analysis and backtesting call the exact
 * same functions, which is what makes a backtest meaningful at all.
 *
 * See internal.ts for the output-alignment contract.
 */

export { IndicatorInputError, lastValue, valueAt, type IndicatorSeries } from './internal.js';
export { sma, ema, roc, linearSlope } from './moving-averages.js';
export { rsi, macd, type MacdResult } from './momentum.js';
export {
  trueRange,
  atr,
  bollingerBands,
  type BollingerResult,
  type OhlcInput,
} from './volatility.js';
export { adx, type AdxResult } from './trend.js';
export { crossAt, lastCross, barsSinceCross, type CrossDirection } from './cross.js';
