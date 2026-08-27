/**
 * Dashboard end-to-end coverage.
 *
 * Requires Playwright, which is not installed yet -- see README.md in this
 * directory. This file is excluded from Vitest and from typecheck so that its
 * imports do not break the build in the meantime.
 */

import { expect, test } from '@playwright/test';

test.describe('BinaryAI dashboard', () => {
  test('loads and identifies itself as demo-only', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('demo mode')).toBeVisible();
  });

  test('lists strategies served by the API', async ({ page }) => {
    await page.goto('/');
    const strategies = page
      .getByRole('heading', { name: 'Strategies' })
      .locator('..')
      .locator('..');
    await expect(strategies.getByText('Trend Momentum')).toBeVisible();
    await expect(strategies.getByText('Range Mean Reversion')).toBeVisible();
  });

  test('shows empty states instead of fabricated market data', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('No signal')).toBeVisible();
    await expect(page.getByText('No analysis')).toBeVisible();
    // The asset selector must stay disabled while no provider is integrated.
    await expect(page.getByLabel('Asset')).toBeDisabled();
  });

  test('states that live trading is disabled', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('disabled')).toBeVisible();
    await expect(page.getByText(/does not place trades/i)).toBeVisible();
  });
});
