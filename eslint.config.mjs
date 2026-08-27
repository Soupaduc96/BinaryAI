// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      // Scratch space for local verification runs -- throwaway scripts and
      // captured output, never part of the product.
      '.tmp/**',
      '**/*.tsbuildinfo',
      'services/ai/reference-python/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // Development rule 8: strong typing. `any` is a defect, not a shortcut.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Development rule 6: no giant monolithic files.
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Scripts and config files are executable tooling, not application code.
  // They run in Node and print to the console on purpose. TypeScript files get
  // their globals from @types/node; plain .mjs needs them declared here.
  {
    files: ['scripts/**/*.{mjs,mts}', '*.config.{mjs,ts}', 'apps/*/*.config.{mjs,ts,js}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },

  // The API is a server process; structured logging goes through Fastify's logger,
  // but bootstrap/shutdown paths may write directly to stderr.
  {
    files: ['apps/api/src/**/*.ts'],
    rules: { 'no-console': ['warn', { allow: ['warn', 'error'] }] },
  },

  prettier,
);
