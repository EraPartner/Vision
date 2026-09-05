import { describe, expect, it } from "vitest";
import { Linter } from "eslint";
import backendEslintConfig, {
  noNullRouteFilter,
  noRepoDirectFromRoute,
} from "../eslint.config.js";

const linter = new Linter({ configType: "flat" });
const filename = "src/routes/example.js";
const config = [
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

function messagesFor(code) {
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
