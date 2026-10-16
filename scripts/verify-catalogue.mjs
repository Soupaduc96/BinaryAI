/**
 * Resolves every catalogue instrument against its real provider.
 *
 * The catalogue is a set of claims: this symbol exists, that provider serves
 * it, and it is the asset class we say it is. A claim nobody checked is a
 * guess, and a guess in a catalogue becomes a broken row in the picker. This
 * script is what lets Phase 10 report instruments as VERIFIED rather than
 * LISTED.
 *
 * It talks to live APIs. Run it deliberately — it is not part of `npm test`,
 * because a test suite that fails when a third party has an outage is a test
 * suite people learn to ignore.
 *
 *   node scripts/verify-catalogue.mjs            all instruments, 1d
 *   node scripts/verify-catalogue.mjs --tf 1h    a different timeframe
 *   node scripts/verify-catalogue.mjs --class forex
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { INSTRUMENT_CATALOGUE } from '../packages/market-data/dist/catalogue.js';
import { createProvider } from '../packages/market-data/dist/registry.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const timeframe = flag('tf', '1d');
const onlyClass = flag('class', null);

const providers = new Map();
const providerFor = (id) => {
  if (!providers.has(id)) providers.set(id, createProvider(id));
  return providers.get(id);
};

const targets = INSTRUMENT_CATALOGUE.filter(
  (instrument) => onlyClass === null || instrument.assetClass === onlyClass,
);

console.log(`Resolving ${targets.length} instruments at ${timeframe}\n`);

const rows = [];
let failures = 0;

for (const instrument of targets) {
  const provider = providerFor(instrument.providerId);
  if (!provider) {
    rows.push([instrument, 'NO PROVIDER', `registry has no adapter '${instrument.providerId}'`]);
    failures += 1;
    continue;
  }

  try {
    const result = await provider.fetchCandles({
      symbol: instrument.symbol,
      timeframe,
      limit: 5,
    });

    const candles = result.candles;
    if (candles.length === 0) {
      // Not a failure on its own — a closed market genuinely has no recent
      // bars — but it is not evidence the symbol resolves either.
      rows.push([instrument, 'EMPTY', `provider returned 0 candles (market closed?)`]);
      continue;
    }

    const last = candles[candles.length - 1];
    const ohlcSane =
      last.high >= last.low &&
      last.high >= Math.max(last.open, last.close) &&
      last.low <= Math.min(last.open, last.close) &&
      last.close > 0;

    if (!ohlcSane) {
      rows.push([instrument, 'BAD OHLC', JSON.stringify(last)]);
      failures += 1;
      continue;
    }

    rows.push([
      instrument,
      'OK',
      `${candles.length} bars, last close ${last.close.toFixed(instrument.quoting.pricePrecision)} ${instrument.quoting.quote}, ${result.meta.latencyMs}ms`,
    ]);
  } catch (error) {
    rows.push([instrument, 'FAILED', `${error.kind ?? 'error'}: ${error.message}`]);
    failures += 1;
  }

  // Spaced deliberately: this walks a provider's whole catalogue, and doing it
  // at full speed is exactly the traffic pattern that earns a 429.
  await sleep(350);
}

let currentClass = null;
for (const [instrument, verdict, detail] of rows) {
  if (instrument.assetClass !== currentClass) {
    currentClass = instrument.assetClass;
    console.log(`\n── ${currentClass.toUpperCase()} (${instrument.providerId})`);
  }
  console.log(
    `  ${verdict.padEnd(11)} ${instrument.displaySymbol.padEnd(10)} ${instrument.providerSymbol.padEnd(10)} ${detail}`,
  );
}

const ok = rows.filter(([, verdict]) => verdict === 'OK').length;
const empty = rows.filter(([, verdict]) => verdict === 'EMPTY').length;
console.log(`\n  ${ok} resolved · ${empty} empty · ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
