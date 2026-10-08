/**
 * ESLint flat config for the node-backend.
 *
 * Two layering rules, one per boundary of `routes → services → repositories`:
 *   - HTTP handlers must not import repositories or the database layer directly.
 *     This covers both `routes/` and the legacy `controllers/` directory. All
 *     data access must flow through the services layer (ADR-067). Routes are
 *     enforced as errors. The legacy controller is reported as a warning until
 *     its existing repository edges are migrated, so new controller files can
 *     no longer bypass the boundary silently. Sole
 *     documented exemption: routes/admin.js, whose table-stats/VACUUM endpoints
 *     are legitimately DB-level (inline eslint-disable there).
 *   - repositories must not import services (the inverse edge). The sanctioned
 *     exceptions are enumerated in SANCTIONED_REPO_SERVICE_IMPORTS below, which
 *     is the machine-readable twin of the callout in
 *     docs/reference/code-patterns.md ("Layering: repositories must not import
 *     services"). Keep the two in sync.
 */

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// ── custom local rule ─────────────────────────────────────────────────────────

/**
 * no-repo-direct-from-route
 *
 * Disallows importing or re-exporting from `../repositories/` (or any path
 * containing `/repositories/`) inside HTTP-handler files, and likewise
 * from the database layer (any path containing `/database/` — `query`,
 * `withTransaction`, etc.), which would let routes run raw SQL and bypass
 * the route→service boundary (ADR-067).
 * HTTP handlers must delegate data access to the services layer.
 */
export const noRepoDirectFromRoute = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "HTTP handlers must not import repositories or the database layer directly; use the services layer instead.",
      url: null,
    },
    messages: {
      noDirectRepo:
        "HTTP handler imports '{{source}}' directly from the repository layer. " +
        "Move data access into a service and import the service here.",
      noDirectDb:
        "HTTP handler imports '{{source}}' directly from the database layer. " +
        "Move the raw SQL into a service/repository and import the service here.",
    },
    schema: [],
  },
  create(context) {
    const check = (node) => {
      const src = node.source?.value;
      if (typeof src !== "string") return;
      if (src.includes("/repositories/") || src.includes("Repository")) {
        context.report({
          node,
          messageId: "noDirectRepo",
          data: { source: src },
        });
      } else if (src.includes("/database/")) {
        context.report({
          node,
          messageId: "noDirectDb",
          data: { source: src },
        });
      }
    };
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    };
  },
};

const ROUTE_FILTER_KEYS = new Set([
  "accountId",
  "accountIds",
  "active",
  "assetClass",
  "bankAccount",
  "bankAccounts",
  "categoryId",
  "categoryIds",
  "detail",
  "endDate",
  "general",
  "isExecuted",
  "isRecurring",
  "name",
  "recipientGroupId",
  "recipientId",
  "recipientIds",
  "recipientName",
  "search",
  "sortBy",
  "sortDir",
  "startDate",
  "tagIds",
  "tagSlugs",
  "transactionId",
  "transactionType",
  "year",
]);

function containsNullFallback(node) {
  if (!node) return false;
  if (node.type === "Literal") return node.value === null;
  if (node.type === "ConditionalExpression") {
    return (
      containsNullFallback(node.consequent) ||
      containsNullFallback(node.alternate)
    );
  }
  if (node.type === "LogicalExpression") {
    return containsNullFallback(node.left) || containsNullFallback(node.right);
  }
  return false;
}

/** Prevent route-owned optional filter models from reintroducing null. */
export const noNullRouteFilter = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Optional route filter values use undefined; reserve null for wire and persistence contracts.",
      url: null,
    },
    messages: {
      useUndefined:
        "Optional route filter '{{name}}' uses null. Use undefined for an absent filter.",
    },
    schema: [],
  },
  create(context) {
    return {
      Property(node) {
        const name = node.key?.name ?? node.key?.value;
        if (!ROUTE_FILTER_KEYS.has(name) || !containsNullFallback(node.value))
          return;
        context.report({
          node: node.value,
          messageId: "useUndefined",
          data: { name },
        });
      },
      VariableDeclarator(node) {
        if (node.id?.type !== "Identifier" || !/Filter$/.test(node.id.name))
          return;
        if (!containsNullFallback(node.init)) return;
        context.report({
          node: node.init,
          messageId: "useUndefined",
          data: { name: node.id.name },
        });
      },
    };
  },
};

/**
 * no-service-import-from-repo
 *
 * The inverse of no-repo-direct-from-route: disallows importing from
 * `../services/` inside files under `src/repositories/`, which inverts the
 * `routes → services → repositories` layering (ADR-067). A repository that
 * reaches into a service can pull in DB/logger/provider-health state — and, in
 * the worst case, a service that opens its own transaction.
 *
 * A closed allowlist carries the sanctioned exceptions documented in
 * docs/reference/code-patterns.md. It is keyed by repository basename and pins
 * BOTH the service module and the exact binding names, so the rule fires on a
 * new repository importing a service, on a sanctioned repository importing a
 * different service, and on a sanctioned repository widening its import to a
 * binding the exception does not cover. Do not add entries: the documented
 * rule is that any pure helper a repository needs belongs in `lib/`.
 */
const SANCTIONED_REPO_SERVICE_IMPORTS = {
  // The `info*` read-repositories aggregate rows and currency-convert them as
  // part of producing API-shaped results — effectively read-services.
  "infoRepositoryAverageVsCurrent.ts": ["convertRowsToEur"],
  "infoRepositoryHelpers.ts": ["convertRowsToEur"],
  "infoRepositoryMonthly.ts": ["convertRowsToEur"],
  "infoRepositoryPlanned.ts": ["convertRowsToEur"],
  "infoRepositoryRecipients.ts": ["convertRowsToEur"],
  "infoRepositoryStatistics.ts": ["convertRowsToEur"],
  "infoRepositoryTags.ts": ["convertRowsToEur"],
};

const SANCTIONED_SERVICE_MODULE =
  "services/currency/currencyConversionService.ts";

const noServiceImportFromRepo = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Repositories must not import services; pure helpers belong in lib/. A closed allowlist carries the sanctioned exceptions.",
      url: null,
    },
    messages: {
      noService:
        "Repository file imports '{{source}}' from the services layer, inverting the " +
        "routes→services→repositories layering (ADR-067). Move the helper to lib/, or lift the " +
        "call into the service that calls this repository.",
      notSanctionedModule:
        "Repository file '{{file}}' has a sanctioned service exception for '" +
        SANCTIONED_SERVICE_MODULE +
        "' only, but imports '{{source}}'. The exception does not extend to other services.",
      notSanctionedBinding:
        "Repository file '{{file}}' imports '{{name}}', which its sanctioned service exception " +
        "does not cover (allowed: {{allowed}}). Widen the exception in " +
        "docs/reference/code-patterns.md and eslint.config.js together, or move the helper to lib/.",
    },
    schema: [],
  },
  create(context) {
    const file = (context.filename ?? context.getFilename()).replace(
      /\\/g,
      "/",
    );
    const basename = file.slice(file.lastIndexOf("/") + 1);
    const allowed = SANCTIONED_REPO_SERVICE_IMPORTS[basename];
    // `export … from '../services/…'` re-exports reach the service layer exactly
    // like an import does, so both node kinds go through the same check.
    const check = (node) => {
      const src = node.source?.value;
      if (typeof src !== "string" || !src.includes("services/")) return;
      if (!allowed) {
        context.report({ node, messageId: "noService", data: { source: src } });
        return;
      }
      if (!src.endsWith(SANCTIONED_SERVICE_MODULE)) {
        context.report({
          node,
          messageId: "notSanctionedModule",
          data: { file: basename, source: src },
        });
        return;
      }
      // `export * from` names nothing, so it can never be pinned to the allowed
      // bindings — it re-exports the whole stateful service surface.
      if (node.type === "ExportAllDeclaration") {
        context.report({ node, messageId: "noService", data: { source: src } });
        return;
      }
      for (const spec of node.specifiers ?? []) {
        const name =
          spec.type === "ImportSpecifier"
            ? spec.imported.name
            : spec.local.name;
        if (!allowed.includes(name)) {
          context.report({
            node: spec,
            messageId: "notSanctionedBinding",
            data: { file: basename, name, allowed: allowed.join(", ") },
          });
        }
      }
    };
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    };
  },
};

/**
 * no-raw-money-arithmetic
 *
 * Warns when monetary identifiers (amount, price, fee, balance, cost, gain,
 * loss, total, sum, cents) appear on either side of `+ - * /` arithmetic,
 * including compound assignments and statically named object properties.
 * Encourages migration to Decimal helpers in `lib/money.ts`. Allowed in
 * `lib/money.ts` itself and in test files.
 */
const MONEY_NAME =
  /^(amount|price|fee|fees|balance|cost|gain|loss|total|sum|cents)$/i;
const MATH_OPS = new Set(["+", "-", "*", "/"]);

const noRawMoneyArithmetic = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Monetary identifiers should not use raw float arithmetic; use Decimal helpers from lib/money.ts.",
      url: null,
    },
    messages: {
      rawMoney:
        "Raw float arithmetic on monetary identifier '{{name}}'. " +
        "Use Decimal helpers from lib/money.ts (toDecimal, addAll, subtract, roundToCents).",
    },
    schema: [],
  },
  create(context) {
    function moneyName(operand) {
      const expression =
        operand?.type === "ChainExpression" ? operand.expression : operand;
      let name;
      if (expression?.type === "Identifier") {
        name = expression.name;
      } else if (expression?.type === "MemberExpression") {
        if (!expression.computed && expression.property.type === "Identifier") {
          name = expression.property.name;
        } else if (
          expression.computed &&
          expression.property.type === "Literal" &&
          typeof expression.property.value === "string"
        ) {
          name = expression.property.value;
        }
      }
      return typeof name === "string" && MONEY_NAME.test(name)
        ? name
        : undefined;
    }

    function checkArithmetic(node) {
      const operator =
        node.type === "AssignmentExpression"
          ? node.operator.slice(0, -1)
          : node.operator;
      if (!MATH_OPS.has(operator)) return;
      const name = moneyName(node.left) ?? moneyName(node.right);
      if (name === undefined) return;
      context.report({ node, messageId: "rawMoney", data: { name } });
    }

    return {
      BinaryExpression: checkArithmetic,
      AssignmentExpression: checkArithmetic,
    };
  },
};

// ── config ────────────────────────────────────────────────────────────────────

export default [
  { ignores: ["node_modules/", "coverage/", "dist/"] },

  // Base rules for all source files (JavaScript and converted TypeScript)
  {
    files: ["src/**/*.{js,ts}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off", // logger handles this; console.log already absent in prod code
    },
  },

  // TypeScript sources: the typescript-eslint parser and recommended rules,
  // with the same unused-variable convention as the JavaScript files.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["src/**/*.ts"],
  })),
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Shared Express shim types still carry `any` at the request/response
      // boundary until runtime schemas replace them; warn so each one stays visible.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // HTTP-handler→repo enforcement — routes are fully migrated and fail lint.
  {
    files: ["src/routes/**/*.{js,ts}"],
    plugins: {
      "vision-local": {
        rules: {
          "no-repo-direct-from-route": noRepoDirectFromRoute,
          "no-null-route-filter": noNullRouteFilter,
        },
      },
    },
    rules: {
      // All routes now go through the services layer; enforce the boundary.
      "vision-local/no-repo-direct-from-route": "error",
      "vision-local/no-null-route-filter": "error",
    },
  },

  // The sole legacy controller still has two existing repository imports. Make
  // that debt visible, and cover any future controller files, without turning
  // the pre-existing edges into a repository-wide lint failure.
  {
    files: ["src/controllers/**/*.{js,ts}"],
    plugins: {
      "vision-local": {
        rules: { "no-repo-direct-from-route": noRepoDirectFromRoute },
      },
    },
    rules: {
      "vision-local/no-repo-direct-from-route": "warn",
    },
  },

  // Repo→service enforcement (the inverse edge) — repositories only.
  {
    files: ["src/repositories/**/*.{js,ts}"],
    plugins: {
      "vision-local": {
        rules: { "no-service-import-from-repo": noServiceImportFromRepo },
      },
    },
    rules: {
      "vision-local/no-service-import-from-repo": "error",
    },
  },

  // Money-arithmetic guard — all backend source except lib/money itself and tests.
  {
    files: ["src/**/*.{js,ts}"],
    ignores: ["src/lib/money.{js,ts}", "test/**", "tests/**", "**/*.test.js"],
    plugins: {
      "vision-local-money": {
        rules: { "no-raw-money-arithmetic": noRawMoneyArithmetic },
      },
    },
    rules: {
      "vision-local-money/no-raw-money-arithmetic": "warn",
    },
  },
];
