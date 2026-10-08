import { describe, expect, it } from "vitest";
import { Linter } from "eslint";
import type { Rule } from "eslint";
import rawBackendEslintConfig, {
  noNullRouteFilter as rawNoNullRouteFilter,
  noRepoDirectFromRoute as rawNoRepoDirectFromRoute,
} from "../eslint.config.js";
import { loose } from "./helpers/partial.ts";

// loose: eslint.config.js is plain JS, so its inferred types widen literals
// (`meta.type`, rule severities) to `string` and miss ESLint's own types.
const backendEslintConfig = loose<Linter.Config[]>(rawBackendEslintConfig);
const noNullRouteFilter = loose<Rule.RuleModule>(rawNoNullRouteFilter);
const noRepoDirectFromRoute = loose<Rule.RuleModule>(rawNoRepoDirectFromRoute);

const linter = new Linter({ configType: "flat" });
const filename = "src/routes/example.js";
const config: Linter.Config[] = [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: {
      "vision-local": {
        rules: { "no-repo-direct-from-route": noRepoDirectFromRoute },
      },
    },
    rules: {
      "vision-local/no-repo-direct-from-route": "error",
    },
  },
];

function messagesFor(code: string) {
  return linter.verify(code, config, { filename });
}

describe("no-repo-direct-from-route", () => {
  it.each([
    [
      "import repository from '../repositories/exampleRepository.js';",
      "noDirectRepo",
    ],
    [
      "export { getAll } from '../repositories/exampleRepository.js';",
      "noDirectRepo",
    ],
    ["export * from '../repositories/exampleRepository.js';", "noDirectRepo"],
    ["export { query } from '../database/connection.js';", "noDirectDb"],
    ["export * from '../database/connection.js';", "noDirectDb"],
  ])("rejects a direct data-layer edge: %s", (code, messageId) => {
    expect(messagesFor(code)).toEqual([
      expect.objectContaining({
        ruleId: "vision-local/no-repo-direct-from-route",
        messageId,
        severity: 2,
      }),
    ]);
  });

  it.each([
    "import { getAll } from '../services/exampleService.js';",
    "export { getAll } from '../services/exampleService.js';",
    "export * from '../services/exampleService.js';",
    "const handler = () => {}; export { handler };",
  ])("allows a service or local edge: %s", (code) => {
    expect(messagesFor(code)).toEqual([]);
  });

  it.each([
    ["src/routes/example.js", 2],
    ["src/controllers/example.js", 1],
  ])(
    "is enabled by the backend config for HTTP handler %s",
    (handlerFilename, severity) => {
      const messages = linter.verify(
        "import repository from '../repositories/exampleRepository.js';",
        backendEslintConfig,
        { filename: handlerFilename },
      );

      expect(messages).toContainEqual(
        expect.objectContaining({
          ruleId: "vision-local/no-repo-direct-from-route",
          messageId: "noDirectRepo",
          severity,
        }),
      );
    },
  );
});

describe("no-null-route-filter", () => {
  it.each([
    "const opts = { search: query.search || null };",
    "const opts = { categoryId: raw ? Number(raw) : null };",
    "const activeFilter = active === 'all' ? null : true;",
  ])("rejects a null optional filter: %s", (code) => {
    const messages = linter.verify(
      code,
      [
        {
          files: ["**/*.js"],
          languageOptions: { ecmaVersion: "latest", sourceType: "module" },
          plugins: {
            local: { rules: { "no-null-route-filter": noNullRouteFilter } },
          },
          rules: { "local/no-null-route-filter": "error" },
        },
      ],
      { filename },
    );
    expect(messages).toEqual([
      expect.objectContaining({
        ruleId: "local/no-null-route-filter",
        messageId: "useUndefined",
      }),
    ]);
  });

  it.each([
    "const opts = { search: query.search || undefined };",
    "const response = { provider: result.provider ?? null };",
    "const payload = { note: body.note || null };",
  ])(
    "allows undefined filters and explicit wire/persistence nulls: %s",
    (code) => {
      const messages = linter.verify(code, backendEslintConfig, { filename });
      expect(
        messages.filter((message) =>
          message.ruleId?.includes("no-null-route-filter"),
        ),
      ).toEqual([]);
    },
  );
});

describe("no-raw-money-arithmetic", () => {
  const ruleId = "vision-local-money/no-raw-money-arithmetic";

  function moneyMessages(
    code: string,
    sourceFilename = "src/services/example.js",
  ) {
    return linter
      .verify(code, backendEslintConfig, { filename: sourceFilename })
      .filter((message) => message.ruleId === ruleId);
  }

  it.each([
    "amount + 1;",
    "1 - row.price;",
    "row.balance * 2;",
    "row['fees'] / 2;",
    "row?.cost + 1;",
    "amount += 1;",
    "row.total -= 1;",
    "row['fee'] *= 2;",
    "row.price /= 2;",
    "counter += row.amount;",
  ])("warns about monetary arithmetic: %s", (code) => {
    expect(moneyMessages(code)).toEqual([
      expect.objectContaining({ messageId: "rawMoney", severity: 1 }),
    ]);
  });

  it.each([
    "counter += 1;",
    "counter + 1;",
    "amount = 1;",
    "row.amount = 1;",
    "row[dynamicProperty] + 1;",
    "row.amount_eur + 1;",
    "amount > 1;",
    "row.amount ?? 0;",
  ])("keeps the existing scoped name and operator policy: %s", (code) => {
    expect(moneyMessages(code)).toEqual([]);
  });

  it.each(["src/lib/money.js", "src/lib/example.test.js", "tests/example.js"])(
    "keeps the existing exemption for %s",
    (sourceFilename) => {
      expect(moneyMessages("amount += row.price;", sourceFilename)).toEqual([]);
    },
  );

  it("reports a single warning when both operands are monetary", () => {
    expect(moneyMessages("row.amount += row.price;")).toHaveLength(1);
  });
});
