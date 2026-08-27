# Provider test fixtures

**Recorded provider-test data.** Captured from the live Coinbase Exchange
public API on 2026-08-25 and frozen here.

| File                       | Endpoint                                     | Contents                      |
| -------------------------- | -------------------------------------------- | ----------------------------- |
| `coinbase-candles-1m.json` | `/products/BTC-USD/candles?granularity=60`   | 50 one-minute candles         |
| `coinbase-candles-1h.json` | `/products/BTC-USD/candles?granularity=3600` | 24 hourly candles             |
| `coinbase-products.json`   | `/products`                                  | 12 online USD-quoted products |
| `coinbase-error-*.json`    | —                                            | Recorded error bodies         |

## Why recorded rather than live

Tests must be deterministic. A suite that calls an external API fails when the
provider has an outage, rate-limits CI, or changes a price — none of which is a
BinaryAI regression. These fixtures pin the exact response _shape_ the adapter
parses, including the `[time, low, high, open, close, volume]` row ordering that
would silently corrupt every candle if assumed to be conventional OHLC.

## What these are NOT

These are historical prices from a specific moment, kept only to exercise
parsing. They are **not** a market feed, must never be served to the UI as
current data, and are never written to the database by application code. Real
prices come from the live provider through the ingestion pipeline.

## Refreshing

Re-record with the documented endpoints above when the provider's response shape
changes. Never hand-edit a fixture to make a test pass — that turns recorded
data into fabricated data.
