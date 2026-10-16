import {
  analyzeMarket,
  evaluateDecision,
  normalizeCandleSeries,
  rawCandleSeriesSchema,
  tightenLimits,
} from '@binaryai/engine';
import { assetFromInstrument, findInstrument } from '@binaryai/market-data';
import type { Instrument, MarketAsset, RiskLimits } from '@binaryai/types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../lib/context.js';
import { persistSignal } from '../lib/persistence.js';
import { errorBody, parseBody } from '../lib/http.js';

/**
 * Analysis and signal evaluation.
 *
 * Both endpoints are stateless and require the caller to supply the candles.
 * That is deliberate for this phase: BinaryAI has no market-data provider, and
 * inventing one would produce exactly the fake intelligence the brief forbids.
 */

const assetSchema = z.object({
  symbol: z.string().min(1).max(32),
  displayName: z.string().min(1).max(64).optional(),
  assetClass: z
    .enum(['forex', 'crypto', 'commodity', 'index', 'stock', 'otc', 'unknown'])
    .default('unknown'),
  pricePrecision: z.number().int().min(0).max(10).default(5),
  isOtc: z.boolean().default(false),
});

const analysisRequestSchema = z.object({
  series: rawCandleSeriesSchema,
  asset: assetSchema.optional(),
});

const evaluateRequestSchema = analysisRequestSchema.extend({
  strategyId: z.string().min(1).max(64),
  parameters: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
  // Opt-in, default off: evaluating a signal is a read-only operation unless
  // the caller explicitly asks for it to be recorded.
  persist: z.boolean().default(false),
  riskLimits: z
    .object({
      minConfidence: z.number().min(0).max(1).optional(),
      maxVolatilityAtrPercent: z.number().min(0).max(100).optional(),
      minDataQualityScore: z.number().min(0).max(1).optional(),
      maxConsecutiveLosses: z.number().int().min(0).max(100).optional(),
    })
    .optional(),
});

/**
 * Resolves the instrument for a request. THE CATALOGUE IS THE ONLY AUTHORITY.
 *
 * This function replaces one that merged caller-supplied fields into a
 * `MarketAsset` and handed the result to persistence. That was the D1 defect,
 * and it was not theoretical: posting `{symbol:'PHANTOM-XYZ', assetClass:'forex'}`
 * with `persist:true` wrote a `market_assets` row with the caller's chosen
 * class, persisted an accepted signal, allowed a paper position to be opened
 * against it, and committed exposure to the append-only ledger — for an
 * instrument with no provider and no candles, so settlement could never resolve
 * it. The result was IRREVERSIBLE: the ledger's no-delete trigger and the
 * RESTRICT foreign keys chaining back through positions to signals mean the
 * stranded exposure cannot be removed at all.
 *
 * The rules now:
 *
 *  - A KNOWN symbol takes ALL its metadata from the catalogue. The caller's
 *    `assetClass`, `pricePrecision` and `isOtc` are read but never trusted; a
 *    request claiming BTCUSD is forex gets crypto, because that is what BTCUSD
 *    is. A legacy spelling (`BTC-USD`) resolves to its canonical instrument
 *    rather than creating a second one.
 *  - An UNKNOWN symbol yields `null`. The caller may still evaluate it
 *    statelessly — these endpoints are calculators and that use is legitimate —
 *    but nothing about it may ever reach the database.
 *
 * `series.asset` is the symbol of record: it names the data actually analysed.
 * A caller-supplied `asset.symbol` that disagrees is reported rather than
 * silently preferred.
 */
function resolveRequestInstrument(
  input: z.infer<typeof assetSchema> | undefined,
  seriesSymbol: string,
): { instrument: Instrument | null; asset: MarketAsset; mismatch: string | null } {
  const instrument = findInstrument(seriesSymbol);

  const mismatch =
    input?.symbol !== undefined && input.symbol !== seriesSymbol
      ? `Request asset.symbol "${input.symbol}" does not match series.asset "${seriesSymbol}"; the series is authoritative.`
      : null;

  if (instrument) {
    // Catalogue metadata, whole. Nothing from the caller survives here.
    return { instrument, asset: assetFromInstrument(instrument), mismatch };
  }

  // Not in the catalogue. Describe it honestly as unknown rather than adopting
  // the caller's classification, and let the persistence gate refuse it.
  return {
    instrument: null,
    asset: {
      symbol: seriesSymbol,
      displayName: seriesSymbol,
      assetClass: 'unknown',
      pricePrecision: 5,
      isOtc: false,
    },
    mismatch,
  };
}

/**
 * What the response says about the instrument it actually used.
 *
 * Returned on every evaluation so a caller can SEE that its metadata was
 * replaced by the catalogue rather than silently accepted — a request calling
 * BTCUSD forex gets crypto back, and can tell that it did.
 */
function instrumentDisclosure(resolved: ReturnType<typeof resolveRequestInstrument>) {
  return {
    symbol: resolved.asset.symbol,
    assetClass: resolved.asset.assetClass,
    inCatalogue: resolved.instrument !== null,
    displaySymbol: resolved.instrument?.displaySymbol ?? resolved.asset.symbol,
    persistable: resolved.instrument !== null,
    ...(resolved.mismatch === null ? {} : { warning: resolved.mismatch }),
  };
}

/** The refusal an uncatalogued instrument earns on any persisting path. */
function uncataloguedRefusal(symbol: string, requestId: string) {
  return errorBody(
    'unknown_instrument',
    `${symbol} is not in BinaryAI's instrument catalogue, so a signal for it cannot be stored. ` +
      'GET /v1/instruments lists everything supported. Evaluate without "persist" to compute a ' +
      'result without recording it.',
    undefined,
    requestId,
  );
}

interface PersistenceOutcome {
  readonly stored: boolean;
  readonly id?: string;
  readonly featureCount?: number;
  readonly reason?: string;
  /** Who the stored signal belongs to. Absent when nothing was stored. */
  readonly owner?: 'system' | 'account';
}

/**
 * Persists only when asked AND when a database exists. A caller that asks for
 * persistence without one gets `stored: false` and the reason -- never a
 * silent success that loses the signal.
 */
async function storeIfRequested(
  context: AppContext,
  requested: boolean,
  signal: Parameters<typeof persistSignal>[1],
  deps: {
    strategy: Parameters<typeof persistSignal>[2];
    asset: Parameters<typeof persistSignal>[3];
    /** Null for an unauthenticated caller: the signal is then system-owned. */
    ownerAccountId: string | null;
  },
): Promise<PersistenceOutcome> {
  if (!requested) return { stored: false, reason: 'Not requested (set "persist": true to store).' };
  if (!context.persistence) {
    return { stored: false, reason: 'No database configured (DATABASE_URL is unset).' };
  }

  const result = await persistSignal(
    context.persistence,
    signal,
    deps.strategy,
    deps.asset,
    deps.ownerAccountId,
  );
  return {
    stored: true,
    id: result.stored.id,
    featureCount: result.stored.featureCount,
    owner: deps.ownerAccountId === null ? 'system' : 'account',
  };
}

/**
 * The caller's account policy, or null when there is no account to read.
 *
 * Read fresh per request rather than cached on the session: a policy edited in
 * one tab must bind on the next action in another.
 */
async function accountPolicyLimits(
  context: AppContext,
  accountId: string,
): Promise<RiskLimits | null> {
  const account = await context.persistence?.repositories.accounts.findById(accountId);
  if (!account || !context.paper) return null;
  return context.paper.policyFor(account).limits;
}

export function registerAnalysisRoutes(app: FastifyInstance, context: AppContext): void {
  app.post('/v1/analysis', (request, reply) => {
    const parsed = parseBody(analysisRequestSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const normalized = normalizeCandleSeries(parsed.data.series);
    if (!normalized.ok) {
      return reply
        .code(400)
        .send(
          errorBody(
            'invalid_series',
            'Candle series failed validation.',
            normalized.error,
            request.id,
          ),
        );
    }

    return { analysis: analyzeMarket(normalized.value) };
  });

  app.post('/v1/signals/evaluate', async (request, reply) => {
    const parsed = parseBody(evaluateRequestSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const { strategyId, parameters, riskLimits } = parsed.data;
    if (!context.registry.has(strategyId)) {
      return reply
        .code(404)
        .send(
          errorBody(
            'strategy_not_found',
            `Strategy "${strategyId}" is not registered.`,
            undefined,
            request.id,
          ),
        );
    }

    const normalized = normalizeCandleSeries(parsed.data.series);
    if (!normalized.ok) {
      return reply
        .code(400)
        .send(
          errorBody(
            'invalid_series',
            'Candle series failed validation.',
            normalized.error,
            request.id,
          ),
        );
    }

    const requested = normalized.value;
    const requestedInstrument = findInstrument(requested.asset);

    /*
     * The series carries the CANONICAL symbol from here on.
     *
     * `market_assets` was written from the resolved catalogue instrument while
     * `signals.asset_symbol` was written from `signal.asset`, which the engine
     * takes from `series.asset` — the caller's spelling. Posting a series
     * labelled `BTC-USD` therefore stored a BTCUSD asset row and a BTC-USD
     * signal row, in the same transaction.
     *
     * The consequence was worse than a cosmetic split: such a row is
     * unreachable by ANY valid query. `?asset=BTCUSD` does not match it, and
     * `?asset=BTC-USD` resolves to BTCUSD and does not match it either. It also
     * gave the alias its own partition in the settlement round-robin and its
     * own key in every analytics grouping.
     *
     * Renaming the spelling does not change WHICH data was analysed — the
     * catalogue already asserts BTC-USD and BTCUSD are one instrument — so the
     * series stays authoritative about its candles while the identity becomes
     * the one the rest of the system uses.
     */
    const series =
      requestedInstrument && requestedInstrument.symbol !== requested.asset
        ? { ...requested, asset: requestedInstrument.symbol }
        : requested;

    // The ACCOUNT's stored policy is authoritative. A caller-supplied override
    // may only tighten it -- otherwise any user could bypass their own limits
    // by sending looser ones with each request, and the stored policy would be
    // decorative. An unauthenticated caller has no account, so its overrides
    // apply to the engine defaults as before.
    const accountLimits =
      request.principal.kind === 'user' && request.principal.accountId && context.paper
        ? await accountPolicyLimits(context, request.principal.accountId)
        : null;
    const effectiveLimits =
      accountLimits === null ? riskLimits : tightenLimits(accountLimits, riskLimits);

    // Compared against what the CALLER sent, so a mismatch is still reported
    // against the text they actually wrote rather than the canonical form.
    const resolved = resolveRequestInstrument(parsed.data.asset, requested.asset);

    /*
     * D1 — the persistence gate.
     *
     * Refused BEFORE the engine runs, so an uncatalogued instrument cannot
     * reach `market_assets`, `signals`, `paper_positions` or the ledger. The
     * order matters: everything downstream of this point writes.
     */
    if (parsed.data.persist && !resolved.instrument) {
      return reply.code(404).send(uncataloguedRefusal(series.asset, String(request.id)));
    }

    const decision = evaluateDecision({
      asset: resolved.asset,
      series,
      strategy: context.registry.get(strategyId),
      ...(parameters === undefined ? {} : { parameters }),
      // Demo is the only mode this build supports; it is not caller-selectable.
      executionMode: 'demo',
      ...(effectiveLimits === undefined ? {} : { riskLimits: effectiveLimits }),
    });

    const persistence = await storeIfRequested(context, parsed.data.persist, decision.signal, {
      strategy: context.registry.get(strategyId),
      // The SAME resolved asset the engine saw. Two independent constructions
      // were how the engine and the database could disagree about what was
      // analysed.
      asset: resolved.asset,
      // A signal a user asked for belongs to that user. An unauthenticated
      // caller (auth disabled, or a machine token) produces a system signal,
      // which is exactly what the runtime worker writes.
      ownerAccountId: request.principal.kind === 'user' ? request.principal.accountId : null,
    });

    return {
      signal: decision.signal,
      risk: decision.risk,
      analysis: decision.analysis,
      persistence,
      instrument: instrumentDisclosure(resolved),
    };
  });

  /**
   * Explanation is derived from a fresh evaluation rather than from a signal
   * posted by the client. A client-supplied "signal" could be forged, and an
   * explanation of a forged signal would be a fabricated rationale.
   */
  app.post('/v1/signals/explain', async (request, reply) => {
    const parsed = parseBody(evaluateRequestSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const { strategyId, parameters } = parsed.data;
    if (!context.registry.has(strategyId)) {
      return reply
        .code(404)
        .send(
          errorBody(
            'strategy_not_found',
            `Strategy "${strategyId}" is not registered.`,
            undefined,
            request.id,
          ),
        );
    }

    const normalized = normalizeCandleSeries(parsed.data.series);
    if (!normalized.ok) {
      return reply
        .code(400)
        .send(
          errorBody(
            'invalid_series',
            'Candle series failed validation.',
            normalized.error,
            request.id,
          ),
        );
    }

    const requested = normalized.value;
    const resolved = resolveRequestInstrument(parsed.data.asset, requested.asset);
    // Canonical identity here too. This route persists nothing, so it cannot
    // split a stored row — but a response labelled with the caller's spelling
    // is still a signal named after something the catalogue does not call it.
    const series =
      resolved.instrument && resolved.instrument.symbol !== requested.asset
        ? { ...requested, asset: resolved.instrument.symbol }
        : requested;
    const decision = evaluateDecision({
      asset: resolved.asset,
      series,
      strategy: context.registry.get(strategyId),
      ...(parameters === undefined ? {} : { parameters }),
      executionMode: 'demo',
    });

    // The provider reports what produced the text; the route makes no claim.
    const explanation = await context.aiProvider.explain({
      signal: decision.signal,
      analysis: decision.analysis,
    });

    return { signal: decision.signal, explanation };
  });
}
