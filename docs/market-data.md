# Market data

How market data enters BinaryAI, what happens to it, and what it is not.

## The distinction that matters most

**Market data is not broker pricing.**

BinaryAI ingests candles from an exchange: prices at which trades actually
matched on that venue. A binary-options broker quotes and settles on _its own_
feed, which is constructed differently and can differ in price, in timing, and
in which tick counts at expiry.

Treating the two as interchangeable is the single most consequential mistake
this system could make — a backtest or a signal built on exchange candles does
not describe what a broker would have settled. So provenance is part of the data
model rather than a footnote:

| `dataOrigin` | Meaning                                                          |
| ------------ | ---------------------------------------------------------------- |
| `exchange`   | Matched trades on a named venue (what Coinbase supplies)         |
| `aggregated` | Combined across venues by a provider's methodology               |
| `indicative` | Reference pricing, not necessarily tradable                      |
| `broker`     | A broker's own quote and settlement feed — **BinaryAI has none** |
| `synthetic`  | Generated. Tests and demos only                                  |

Every fetch records its origin, every stored candle records its `source`, and
the dashboard shows the provider and its origin in the market context strip.

## Pipeline

```
Provider API
   ↓  adapter          translate the vendor's format; no vendor type escapes
ProviderFetchResult
   ↓  normalize        UTC epoch ms, canonical CandleSeries, schema-validated
CandleSeries
   ↓  quality scan     integrity, timestamps, sequence, provider, staleness
IngestionQualityReport
   ↓  upsert           idempotent on (asset, timeframe, opened_at)
CandleRepository
   ↓
Analysis engine
```

Each stage is a pure function of its input, so the whole chain is testable
without a network.

## Provider abstraction

Everything downstream depends on `MarketDataProvider` from `@binaryai/types`.
No vendor name, symbol format or response shape leaks past the adapter, which is
what makes a second provider additive:

```ts
interface MarketDataProvider {
  readonly capabilities: ProviderCapabilities;
  listAssets(): Promise<readonly ProviderAsset[]>;
  fetchCandles(request: CandleRequest): Promise<ProviderFetchResult>;
  ping(): Promise<boolean>;
}
```

`ProviderCapabilities` is honest about limits — supported timeframes, request
ceiling, streaming support, rate limit, data origin and a plain-language list of
limitations. The API surfaces it verbatim so the UI never has to guess.

Adding a provider: implement the interface, register it in `registry.ts`, add
the id to `MARKET_DATA_PROVIDER`. Nothing else changes.

## Asset mapping

Provider symbols never appear outside an adapter:

```
BTC-USD  (provider)  <->  BTCUSD  (BinaryAI)  ->  BTC/USD  (display)
```

The mapper matches the longest quote currency first, so `BTCUSDT` maps to
`BTC-USDT` rather than `BTC-USD` + `T`.

## Normalization

- Timestamps are **epoch milliseconds, UTC**, everywhere. Providers speaking
  seconds or ISO strings convert in their adapter.
- Candles are returned **ascending**; Coinbase serves newest-first.
- Volume is `null` when absent, never `0`.
- Nothing is guessed and nothing is repaired. A structurally invalid candle is
  rejected — a repaired candle is a fabricated one, and by the time a strategy
  sees it there is no way to tell the difference.

Normalization reuses the engine's existing `normalizeCandleSeries` boundary, so
provider data is held to exactly the same schema as candles posted to the API.

## Quality validation

`validateIngestedBatch` reports rather than discards. Errors reject a candle;
warnings annotate it.

| Category   | Checks                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------- |
| Values     | positive prices, finite numbers, `high ≥ max(open,close)`, `low ≤ min(open,close)`, negative volume |
| Timestamps | future beyond tolerance (default 120s clock skew), alignment to the timeframe boundary              |
| Sequence   | duplicates, out-of-order, overlapping, missing intervals                                            |
| Provider   | timeframe actually supported, staleness against a threshold                                         |

Two decisions worth stating:

**Gaps are never filled.** A missing interval is reported and counted. An
interpolated candle is invented data.

**Unaligned bars are rejected.** A "1m" candle starting at 00:00:37 is not the
bar it claims to be, and would misalign every indicator computed from it.

The report always describes the full batch even when the caller stores only the
clean subset, so a rejection stays visible instead of being implied by a smaller
number.

## Historical ingestion

```
POST /v1/market-data/ingest
{ "asset": "BTCUSD", "timeframe": "1m", "from": <epoch ms>, "to": <epoch ms> }
```

Bounded at every step, deliberately:

- `from` and `to` are **required** — there is no "fetch everything" path.
- A run stops at a candle ceiling (default 5,000) and reports `partial` rather
  than truncating silently.
- Windows are planned around the provider's per-request ceiling (300 for
  Coinbase) and requests are spaced to its rate limit.
- Retries use **bounded exponential backoff**, capped, never an infinite loop.
- Only retryable failures are retried. A 401 or an unsupported timeframe fails
  immediately instead of burning the rate budget.
- Partial data already stored stays stored, and the run says `partial`.

## Streaming vs polling

Coinbase Exchange's websocket feed carries `ticker` and `matches`, but **no
candle channel**. Candles would have to be aggregated from the trade stream,
which is real work and a source of subtle divergence from the provider's own
bars.

**This phase therefore uses polling**, and the architecture is shaped for it:
ingestion is a bounded, idempotent, repeatable operation. A scheduler calling it
on an interval produces near-real-time data whose freshness is exactly the poll
period.

Limitations of polling, stated plainly: latency is bounded below by the poll
interval; the most recent candle is usually still forming; and polling costs a
request whether or not anything changed. `supportsStreaming: false` is declared
in the provider's capabilities so no consumer assumes otherwise.

## Storage

`CandleRepository.upsertSeries` writes idempotently on
`(asset_id, timeframe, opened_at)`. Re-delivering a bar updates it rather than
duplicating — verified against a live backfill: 180 candles ingested, re-ingested,
still 180 rows.

`source` is stored with every candle, so synthetic data can never be read back
as live-provider data.

## Observability

`IngestionTracker` records runs, successes, failures, totals and latency.
`buildMarketDataStatus` resolves the state the dashboard shows:

| State            | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `not_configured` | No provider configured                                      |
| `disconnected`   | Provider not answering — stored data is not being refreshed |
| `degraded`       | Reachable, but nothing ingested yet                         |
| `stale`          | Newest candle older than the threshold — **not current**    |
| `connected`      | Fresh data                                                  |

`stale` exists as a distinct state on purpose. Showing a last-known price as
though it were current is precisely the failure this field prevents.

Ingestion also writes to `system_events` (category `market_data`), so history
survives a restart.

## Failure modes

| Failure                | Behaviour                                                  |
| ---------------------- | ---------------------------------------------------------- |
| Provider offline       | Status `disconnected`; no stale data presented as current  |
| Rate limited (429)     | Retryable; backoff and retry within the cap                |
| Auth failure (401/403) | Not retryable; run fails immediately                       |
| Timeout                | Retryable                                                  |
| Malformed JSON         | `malformed_response`; batch rejected, not partially parsed |
| Empty response         | Recorded as a warning, not an error                        |
| Unsupported timeframe  | Refused before any request is made                         |
| Partial batch          | Stored, run reports `partial` with the reason              |

## API

| Endpoint                      | Purpose                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `GET /v1/market-data/status`  | Connection state, provider capabilities, ingestion counters |
| `GET /v1/market-data/assets`  | Provider instrument universe as BinaryAI symbols            |
| `GET /v1/market-data/candles` | Stored candles for one instrument and timeframe             |
| `POST /v1/market-data/ingest` | Bounded historical backfill                                 |
| `GET /v1/assets`              | Instruments BinaryAI holds data for                         |

Security: no credential is ever returned; the client names a _symbol_, never a
URL, so no request body can reach an arbitrary host; every parameter is
validated; and provider access is server-side only.

## Configuration

```bash
MARKET_DATA_PROVIDER=coinbase       # none | coinbase
MARKET_DATA_STALENESS_SECONDS=300
# MARKET_DATA_API_KEY=              # unused by coinbase; for keyed providers
```

Coinbase needs no credentials. `MARKET_DATA_API_KEY` exists for the keyed
providers that will supply forex and indices.

## Current limitations

- **Crypto only.** No forex, indices or commodities.
- **1m, 5m, 15m, 1h, 1d.** 30m and 4h are refused, never resampled.
- **Polling, not streaming.**
- **Exchange data, not broker settlement pricing.**
- **No scheduler yet** — ingestion is triggered through the API.
