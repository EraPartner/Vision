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

/**
 * no-raw-money-arithmetic
 *
 * Warns when monetary identifiers (amount, price, fee, balance, cost, gain,
 * loss, total, sum, cents) appear on either side of a `+ - * /` BinaryExpression.
 * Encourages migration to Decimal helpers in `lib/money.js`. Allowed in
 * `lib/money.js` itself and in test files.
 */
const MONEY_NAME = /^(amount|price|fee|fees|balance|cost|gain|loss|total|sum|cents)$/i;
const MATH_OPS = new Set(['+', '-', '*', '/']);

const noRawMoneyArithmetic = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Monetary identifiers should not use raw float arithmetic; use Decimal helpers from lib/money.js.',
      url: null,
    },
    messages: {
      rawMoney:
        "Raw float arithmetic on monetary identifier '{{name}}'. " +
        'Use Decimal helpers from lib/money.js (toDecimal, addAll, subtract, roundToCents).',
    },
    schema: [],
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (!MATH_OPS.has(node.operator)) return;
        for (const side of [node.left, node.right]) {
          if (side?.type === 'Identifier' && MONEY_NAME.test(side.name)) {
            context.report({ node, messageId: 'rawMoney', data: { name: side.name } });
            return;
          }
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

  // Money-arithmetic guard — all backend source except money.js itself and tests.
  {
    files: ['src/**/*.js'],
    ignores: ['src/lib/money.js', 'test/**', 'tests/**', '**/*.test.js'],
    plugins: {
      'vision-local-money': { rules: { 'no-raw-money-arithmetic': noRawMoneyArithmetic } },
    },
    rules: {
      'vision-local-money/no-raw-money-arithmetic': 'warn',
    },
  },
];
