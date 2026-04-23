/**
 * ESLint flat config for the node-backend.
 *
 * Key rule: routes must not import repositories directly.
 * All data access must flow through the services layer.
 *
 * Existing violations are reported as warnings so they can be fixed
 * incrementally without blocking CI.  New violations added after the
 * rule is introduced will be caught in code review.
 */

import js from '@eslint/js';
import globals from 'globals';

// ── custom local rule ─────────────────────────────────────────────────────────

/**
 * no-repo-direct-from-route
 *
 * Disallows importing from `../repositories/` (or any path containing
 * `/repositories/`) inside files under `src/routes/`.
 * Routes must delegate data access to the services layer.
 */
const noRepoDirectFromRoute = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Routes must not import repositories directly; use the services layer instead.',
      url: null,
    },
    messages: {
      noDirectRepo:
        "Route file imports '{{source}}' directly from the repository layer. " +
        'Move data access into a service and import the service here.',
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const src = node.source.value;
        if (src.includes('/repositories/') || src.includes('Repository')) {
          context.report({
            node,
            messageId: 'noDirectRepo',
            data: { source: src },
          });
        }
      },
    };
  },
};

// ── config ────────────────────────────────────────────────────────────────────

export default [
  { ignores: ['node_modules/', 'coverage/', 'dist/'] },

  // Base JS rules for all source files
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off', // logger handles this; console.log already absent in prod code
    },
  },

  // Route→repo enforcement — routes only
  {
    files: ['src/routes/**/*.js'],
    plugins: {
      'vision-local': { rules: { 'no-repo-direct-from-route': noRepoDirectFromRoute } },
    },
    rules: {
      // warn: existing violations surface without blocking; treat as tech-debt
      'vision-local/no-repo-direct-from-route': 'warn',
    },
  },
];
