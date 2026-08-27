import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.join(root, 'packages', name, 'src', 'index.ts');

/**
 * Tests run against package *source* (not build output) so the feedback loop stays fast.
 * The aliases below mirror the workspace links npm creates in node_modules.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@binaryai/types': pkg('types'),
      '@binaryai/utils': pkg('utils'),
      '@binaryai/config': pkg('config'),
      '@binaryai/database': pkg('database'),
      '@binaryai/fixtures': pkg('fixtures'),
      '@binaryai/market-data': pkg('market-data'),
      '@binaryai/rate-limit': pkg('rate-limit'),
      '@binaryai/runtime': pkg('runtime'),
      '@binaryai/indicators': pkg('indicators'),
      '@binaryai/strategies': pkg('strategies'),
      '@binaryai/engine': pkg('engine'),
      '@binaryai/backtest': pkg('backtest'),
      '@binaryai/auth': pkg('auth'),
      '@binaryai/analytics': pkg('analytics'),
      // The web app resolves '@/...' to its own src via tsconfig paths; mirror
      // that here so its lib layer is testable from the root suite.
      '@': path.join(root, 'apps', 'web', 'src'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/**/*.test.ts',
      'apps/api/**/*.test.ts',
      'apps/web/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/db/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'tests/e2e/**'],
    reporters: ['default'],
    // Spinning up an embedded PostgreSQL and running migrations is slower than a
    // pure unit test, but still seconds rather than minutes.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
