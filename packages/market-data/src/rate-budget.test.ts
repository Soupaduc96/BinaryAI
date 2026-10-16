import { describe, expect, it } from 'vitest';
import { createRateBudget } from './rate-budget.js';
import { createProviderRouter } from './registry.js';

/**
 * Phase 11C Step 9 — one shared budget per provider, enforced under concurrency.
 *
 * The measurements here are of BinaryAI's OWN conservative spacing. They say
 * nothing about any vendor's real quota: Coinbase publishes one, Yahoo's chart
 * endpoint publishes nothing, and a number invented for it would be fiction.
 */

describe('rate budget spacing', () => {
  it('spaces sequential acquisitions by the configured interval', async () => {
    const budget = createRateBudget(2); // 2/s -> 500ms apart
    expect(budget.minIntervalMs).toBe(500);

    const started = Date.now();
    const stamps: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      await budget.acquire();
      stamps.push(Date.now() - started);
    }

    // Three requests occupy two intervals: ~0ms, ~500ms, ~1000ms.
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(450);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(450);
  });

  it('holds the spacing when callers arrive SIMULTANEOUSLY', async () => {
    // The failure this guards: four ingestion runs starting together, each
    // reading the same `lastRequestAt`, each deciding it need not wait, and
    // all four firing at once — four times the configured budget.
    const budget = createRateBudget(4); // 250ms apart
    const started = Date.now();

    const stamps = await Promise.all(
      Array.from({ length: 4 }, async () => {
        await budget.acquire();
        return Date.now() - started;
      }),
    );

    const ordered = [...stamps].sort((a, b) => a - b);
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index]! - ordered[index - 1]!).toBeGreaterThanOrEqual(200);
    }
    // Four requests at 250ms spacing cannot finish in under ~750ms.
    expect(ordered[3]!).toBeGreaterThanOrEqual(700);
  });

  it('reserves the slot up front, so no caller can bypass it', async () => {
    const budget = createRateBudget(2);
    // Acquire without awaiting: the second call must still be pushed out by
    // the first caller's reservation even though its request has not happened.
    const first = budget.acquire();
    const secondStart = Date.now();
    await first;
    await budget.acquire();
    expect(Date.now() - secondStart).toBeGreaterThanOrEqual(450);
  });
});

describe('one budget per provider, shared across asset classes', () => {
  it('gives every Yahoo-served class the SAME budget instance', () => {
    const router = createProviderRouter({
      crypto: 'coinbase',
      equity: 'yahoo',
    });

    const forex = router.budgetFor('forex');
    const stock = router.budgetFor('stock');
    const index = router.budgetFor('index');
    const commodity = router.budgetFor('commodity');

    // Identity, not equality: four classes must queue through ONE allowance.
    // Four separate budgets would quadruple the request rate while every
    // individual budget still looked correctly configured.
    expect(forex).not.toBeNull();
    expect(stock).toBe(forex);
    expect(index).toBe(forex);
    expect(commodity).toBe(forex);
  });

  it('gives crypto a SEPARATE budget from the equity provider', () => {
    const router = createProviderRouter({
      crypto: 'coinbase',
      equity: 'yahoo',
    });
    // Different vendors, different allowances: Coinbase traffic must not
    // consume Yahoo's spacing or vice versa.
    expect(router.budgetFor('crypto')).not.toBe(router.budgetFor('stock'));
  });
});
