/**
 * @binaryai/fixtures -- deterministic SYNTHETIC data for tests and demos.
 *
 * Never import this from apps/api, apps/web or any analysis path. If a chart or
 * a metric can be traced back to this package, it must be labelled synthetic in
 * the UI. See docs/development-principles.md (rules 2 and 3).
 */

export {
  createSyntheticSeries,
  syntheticUptrend,
  syntheticDowntrend,
  syntheticRange,
  syntheticVolatile,
  type SyntheticSeriesOptions,
} from './synthetic.js';
export { defaultTestAsset, seriesWindow } from './helpers.js';
