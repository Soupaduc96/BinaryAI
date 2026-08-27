#!/usr/bin/env node
/** Removes build output from every workspace. Does not touch node_modules. */

import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'packages/types/dist',
  'packages/utils/dist',
  'packages/config/dist',
  'packages/fixtures/dist',
  'packages/indicators/dist',
  'packages/strategies/dist',
  'packages/engine/dist',
  'packages/backtest/dist',
  'apps/api/dist',
  'apps/web/.next',
  'coverage',
];

for (const target of targets) {
  await rm(path.join(root, target), { recursive: true, force: true });
  console.log(`removed ${target}`);
}
