# ADR-0008 — Coinbase Exchange as the first market-data provider

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

Phase 2B needed a real external market-data source behind a provider-neutral
interface. The selection criteria were data quality, latency, asset coverage,
reliability, API usability and cost — explicitly _not_ "whichever is free".

One constraint shaped the evaluation more than any other: **a provider that
cannot be exercised cannot be verified.** An adapter written against
documentation alone, with no way to make a real call, is a guess with tests that
only prove the guess is self-consistent.

## Providers evaluated

Each candidate was probed from the development machine rather than assessed from
its marketing pages.

| Provider              | Credentials | Result                                                                      | Verdict                     |
| --------------------- | ----------- | --------------------------------------------------------------------------- | --------------------------- |
| **Coinbase Exchange** | None        | HTTP 200; honours explicit `start`/`end` windows                            | **Selected**                |
| Kraken                | None        | HTTP 200, but `since` a week back returned only the most recent 721 candles | Rejected                    |
| Binance               | None        | **HTTP 451** — "restricted location" from this region                       | Rejected                    |
| Bitstamp              | None        | HTTP 200, works, narrower asset and timeframe coverage                      | Runner-up                   |
| Twelve Data           | API key     | Forex + indices + crypto, 800 req/day free                                  | Deferred — no key available |
| Polygon.io            | API key     | Excellent US equities/forex, 5 req/min free                                 | Deferred — no key available |
| Alpha Vantage         | API key     | Broad coverage, very low free limits                                        | Deferred                    |
| Finnhub               | API key     | Forex behind a paid tier                                                    | Deferred                    |

**Kraken is the instructive rejection.** It is a reputable exchange with a clean
public API and no key requirement, and it was the leading candidate until
tested: requesting `since` a week ago returned 721 candles covering the last
twelve hours. Its OHLC endpoint serves a rolling window, not a historical range.
Since historical backfill is _the_ deliverable of this phase, that is
disqualifying — and it is not stated prominently in the documentation.

## Decision

**Coinbase Exchange public market-data API.** No credentials, no account, no
trading scope.

Verified empirically before selection:

- `start`/`end` windows return the requested historical range (a week-old
  window returned exactly that week's candles), so pagination works.
- Granularities 60, 300, 900, 3600, 86400 are served; 1800 and 14400 return
  `{"message":"Unsupported granularity"}`.
- 520 online products, 400 USD-quoted.
- Round-trip latency ~65–715ms from this machine.

End-to-end proof: 180 real BTC-USD 1-minute candles fetched, normalised,
quality-scanned, stored in PostgreSQL and read back — 0 rejected, 0 duplicates,
0 missing intervals, and a repeat run produced no duplicate rows.

## Rationale

**It can be verified today.** Zero credentials means the adapter is written
against observed behaviour, not documentation, and CI can exercise it without a
secret.

**It is exchange data, not aggregated or indicative.** Candles are built from
matched trades on a specific venue with a known construction. An aggregator's
"price" is a methodology, and an indicative feed is not tradable at all.

**Historical range works.** The primary Phase 2B requirement.

**Cost is zero at this stage**, but that is a consequence of the choice rather
than the reason for it: Kraken and Bitstamp are equally free and were judged on
capability.

## Consequences

**Good.** A complete, verified pipeline today. No secret to manage or leak. Deep
history for backfill. Documented, stable identifiers.

**Bad — and these are real limitations, not caveats:**

- **Cryptocurrency only.** Forex, indices and commodities — arguably the more
  typical binary-options underlyings — are not covered. Adding them means adding
  a keyed provider.
- **Five of BinaryAI's twelve timeframes** (1m, 5m, 15m, 1h, 1d). 30m and 4h are
  refused rather than resampled, because a resampled bar is one the provider
  never published.
- **300 candles per request**, so backfill is paginated and rate-limited.
- **No candle websocket channel** on the Exchange feed. Near-real-time requires
  polling; see docs/market-data.md.
- **No availability SLA** on public endpoints.

**Neutral.** `dataOrigin: 'exchange'` is recorded on every fetch and stored with
every candle, so this data can never be silently conflated with broker pricing.

## Revisit if

Forex or index coverage is required (add a keyed provider — the interface is
already provider-neutral), sub-minute candles are needed, streaming becomes a
requirement, or public-endpoint reliability proves insufficient. Adding a second
provider is additive: implement `MarketDataProvider`, register it, and nothing
else changes.
