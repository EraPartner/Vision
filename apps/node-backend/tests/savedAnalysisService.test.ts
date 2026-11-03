import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { APP_TIMEZONE, appDateStringToUtc } from "../src/lib/timezone.ts";
import {
  ANALYSIS_SQL_NEEDS_REVIEW,
  __buildDefinition as buildDefinition,
  __runtimeRequest as runtimeRequest,
  __resolveFormulaModel,
  __finalizeSavedAnalysisResult,
  createSavedAnalysis,
  getSavedAnalysis,
  listSavedAnalyses,
  listSavedAnalysisVersions,
  runSavedAnalysis,
  updateSavedAnalysis,
} from "../src/services/savedAnalysisService.ts";
import { closeAnalysisPool } from "../src/services/analysisExecutor.ts";
import { getTestPool } from "./setup/db.ts";
import type { SavedAnalysis } from "../src/services/savedAnalysisService.ts";
import type {
  AnalysisFormulaModel,
  AnalysisResultLike,
} from "../src/services/analysisWorkbenchService.ts";
import type {
  AnalysisCustomSqlSource,
  AnalysisVisualPlanSource,
} from "@vision/types/analysis";
import { partial } from "./helpers/partial.ts";
import { must } from "./helpers/must.ts";

/** The visual branch of runtimeRequest's result (the only one with `limit`). */
type VisualRuntimeRequest = Extract<
  ReturnType<typeof runtimeRequest>,
  { limit: unknown }
>;

describe("saved analysis definitions", () => {
  it("builds a strict, versioned visual definition for every workspace", () => {
    for (const workspace of [
      "budgeting",
      "portfolio",
      "research",
      "cross-workspace",
    ]) {
      const definition = buildDefinition({
        definitionId: `analysis:${workspace}`,
        version: 2,
        name: "Monthly spending",
        workspace,
        parameters: {
          currency: "EUR",
          timezone: "Europe/Helsinki",
          date_from: "2026-01-01",
          date_to: "2026-12-31",
        },
        querySpec: {
          mode: "visual",
          plan: {
            datasetId: "cash-flows",
            fields: ["month"],
            groups: ["month"],
            measures: ["sum_spending"],
            filters: [{ fieldId: "currency", operator: "eq", value: "EUR" }],
            joins: [],
            orderBy: [{ id: "month", direction: "desc" }],
            limit: 500,
          },
        },
      });
      const source = definition.source as AnalysisVisualPlanSource;
      const saved = partial<SavedAnalysis>({ definition, parameters: {} });
      expect(definition.workspace).toBe(workspace);
      expect(definition.definitionVersion).toBe(2);
      // Money totals are exact decimal sums in SQLite (ADR-263).
      expect(source.generatedSql).toContain("dec_sum(spending_amount)");
      expect(source.orderBy).toEqual([
        { outputId: "month", direction: "desc" },
      ]);
      expect(runtimeRequest(saved).sql).toBe(source.generatedSql);
      expect(source.generatedSql).toMatch(/ORDER BY.*month.*DESC/);
      expect((runtimeRequest(saved) as VisualRuntimeRequest).limit).toBe(500);
      expect(source.generatedSql).not.toMatch(/LIMIT/i);
    }
  });

  it("defaults date_to to the app-zone day just after local midnight, not the UTC day", () => {
    // 00:30 on 4 Nov in APP_TIMEZONE: the UTC day is still 3 Nov east of UTC.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(appDateStringToUtc("2026-11-04").getTime() + 30 * 60_000);
    try {
      const definition = buildDefinition({
        definitionId: "analysis:defaults",
        version: 1,
        name: "Defaults",
        workspace: "budgeting",
        parameters: {},
        querySpec: {
          mode: "visual",
          plan: {
            datasetId: "cash-flows",
            fields: ["month"],
            groups: ["month"],
            measures: ["sum_spending"],
            filters: [{ fieldId: "currency", operator: "eq", value: "EUR" }],
            joins: [],
            orderBy: [],
            limit: 500,
          },
        },
      });
      const byId = new Map(
        definition.parameters.map((parameter) => [parameter.id, parameter]),
      );
      expect(byId.get("date_to")?.defaultValue).toBe("2026-11-04");
      // The label names the zone the datasets are bucketed in.
      expect(byId.get("timezone")?.defaultValue).toBe(APP_TIMEZONE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves custom SQL verbatim and marks visual conversion unsupported", () => {
    const sql =
      "SELECT account_name FROM vision_analysis.accounts_v1 ORDER BY account_name";
    const definition = buildDefinition({
      definitionId: "analysis:sql",
      version: 1,
      name: "Accounts",
      workspace: "budgeting",
      parameters: {},
      querySpec: {
        mode: "sql",
        sql,
        datasetIds: ["accounts"],
        visualOrigin: {
          datasetId: "accounts",
          fields: ["account_name"],
          groups: [],
          measures: [],
          filters: [],
          joins: [],
          orderBy: [],
          limit: 500,
        },
        columns: [
          {
            id: "account_name",
            label: "Account",
            type: "string",
            nullable: true,
          },
        ],
      },
    });
    const source = definition.source as AnalysisCustomSqlSource;
    expect(source.text).toBe(sql);
    // Saved through the API, custom SQL is SQLite SQL (ADR-263).
    expect(source.dialect).toBe("sqlite");
    expect(source.visualConversion.status).toBe("unsupported");
    expect(must(source.visualOrigin, "source.visualOrigin").datasetId).toBe("accounts");
  });

  it("records joined account fields against the accounts dataset", () => {
    const definition = buildDefinition({
      definitionId: "analysis:joined-account",
      version: 1,
      name: "Spending by account",
      workspace: "budgeting",
      parameters: {},
      querySpec: {
        mode: "visual",
        plan: {
          datasetId: "cash-flows",
          fields: ["account.display_name"],
          groups: ["account.display_name"],
          measures: ["sum_spending"],
          filters: [
            {
              fieldId: "account.display_name",
              operator: "contains",
              value: "Current",
            },
            { fieldId: "currency", operator: "eq", value: "EUR" },
          ],
          joins: ["cash-flows.account"],
          orderBy: [],
          limit: 500,
        },
      },
    });

    const source = definition.source as AnalysisVisualPlanSource;
    expect(must(source.select[0], "source.select[0]").source).toEqual({
      kind: "field",
      datasetId: "accounts",
      columnId: "display_name",
    });
    expect(must(source.filters[0], "source.filters[0]").left).toEqual({
      kind: "field",
      datasetId: "accounts",
      columnId: "display_name",
    });
    expect(definition.datasets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cash-flows", requiredColumns: [] }),
        expect.objectContaining({ id: "accounts", requiredColumns: [] }),
      ]),
    );
  });

  it("persists typed formulas and isolated assumptions in the shared definition", () => {
    const definition = buildDefinition({
      definitionId: "analysis:formula",
      version: 1,
      name: "Scenario",
      workspace: "budgeting",
      parameters: {},
      querySpec: {
        mode: "sql",
        sql: "SELECT amount FROM vision_analysis.cash_flows_v1",
        datasetIds: ["cash-flows"],
        columns: [
          { id: "amount", label: "Amount", type: "decimal", nullable: false },
        ],
      },
      assumptions: [
        {
          id: "growth",
          label: "Growth",
          type: "decimal",
          defaultValue: "0.02",
          editable: true,
          source: "user",
        },
      ],
      formulas: [
        {
          id: "adjusted",
          label: "Adjusted",
          scope: "row",
          expression: "row.amount * (1 + assumption.growth)",
          resultType: "decimal",
          dependencies: [],
        },
      ],
    });
    expect(must(definition.assumptions[0], "definition.assumptions[0]").id).toBe("growth");
    expect(definition.calculations.at(-1)).toMatchObject({
      id: "adjusted",
      kind: "formula",
      languageVersion: "vision-formula-v1",
    });
    expect(definition.expectedResult.columns.at(-1)).toMatchObject({
      id: "adjusted",
      calculationVersion: "vision-formula-v1",
    });
  });

  it("keeps formula edits carried inside an inspected proposal", () => {
    // Formulas carry only an id: resolution never reads their bodies.
    const current = partial<AnalysisFormulaModel>({
      formulas: [{ id: "old" }],
      assumptions: [],
      assumptionValues: {},
    });
    expect(
      __resolveFormulaModel(
        partial<Parameters<typeof __resolveFormulaModel>[0]>({
          parameters: {
            formulaModel: {
              formulas: [{ id: "edited" }],
              assumptions: [{ id: "rate" }],
              assumptionValues: { rate: "0.03" },
            },
          },
        }),
        current,
      ),
    ).toEqual({
      formulas: [{ id: "edited" }],
      assumptions: [{ id: "rate" }],
      assumptionValues: { rate: "0.03" },
    });
  });

  it("joins typed scenario values before evaluating formulas", () => {
    const finalized = __finalizeSavedAnalysisResult(
      {
        rows: [{ plan: "A", actual_cost: "38" }],
        columns: [
          { id: "plan", type: "string" },
          { id: "actual_cost", type: "decimal" },
        ],
        window: { kind: "page", hasMore: false },
      },
      {
        scenarioModel: {
          attachments: [
            {
              id: "options",
              fileName: "options.csv",
              importedAt: "2026-09-14T10:00:00Z",
              sha256: "a".repeat(64),
              columns: [
                { id: "plan", label: "Plan", type: "string" },
                { id: "cost", label: "Cost", type: "decimal" },
              ],
              rows: [{ plan: "A", cost: "40.5" }],
            },
          ],
          joins: [
            { inputId: "options", resultColumn: "plan", inputColumn: "plan" },
          ],
        },
        formulaModel: {
          assumptions: [],
          assumptionValues: {},
          formulas: [
            {
              id: "difference",
              scope: "row",
              expression: "options.cost - actual_cost",
            },
          ],
        },
      },
    );

    expect(finalized.complete).toBe(true);
    expect(finalized.result.columns).toContainEqual(
      expect.objectContaining({
        id: "difference",
        type: "decimal",
        calculationId: "difference",
      }),
    );
    expect(finalized.result.rows[0]).toMatchObject({
      "options.cost": "40.5",
      difference: "2.5",
    });
  });

  it.each([
    { kind: "page", hasMore: true, offset: 0 },
    { kind: "page", hasMore: false, offset: 100 },
    { kind: "truncated", reason: "byte-limit" },
  ] as const)(
    "withholds whole-result formulas for an incomplete window %j",
    (window) => {
      const finalized = __finalizeSavedAnalysisResult(
        partial<AnalysisResultLike>({
          rows: [{ amount: "10" }, { amount: "20" }],
          window,
        }),
        {
          formulaModel: {
            formulas: [
              { id: "total", scope: "summary", expression: "SUM(amount)" },
              {
                id: "twice_total",
                scope: "summary",
                expression: "formula.total * 2",
              },
              { id: "local", scope: "row", expression: "amount * 2" },
              { id: "constant", scope: "summary", expression: "2 + 3" },
            ],
          },
        },
      );
      expect(finalized.complete).toBe(false);
      expect(finalized.result.formulaSummaries).toEqual({
        total: null,
        twice_total: null,
        constant: "5",
      });
      expect(finalized.result.rows.map((row) => row.local)).toEqual([
        "20",
        "40",
      ]);
      expect(
        finalized.result.formulaErrors.map((error) => error.formulaId),
      ).toEqual(["total", "twice_total"]);
    },
  );

  it("calculates summaries when the entire source result is available", () => {
    const finalized = __finalizeSavedAnalysisResult(
      partial<AnalysisResultLike>({
        rows: [{ amount: "10" }, { amount: "20" }],
        window: { kind: "page", hasMore: false, offset: 0 },
      }),
      {
        formulaModel: {
          formulas: [
            { id: "total", scope: "summary", expression: "SUM(amount)" },
          ],
        },
      },
    );
    expect(finalized.complete).toBe(true);
    expect(finalized.result.formulaSummaries.total).toBe("30");
    expect(finalized.result.formulaErrors).toEqual([]);
  });
});

describe("custom SQL written for PostgreSQL (ADR-263)", () => {
  const pgSql =
    "SELECT account_name, count(*)::int AS n FROM vision_analysis.accounts_v1 GROUP BY account_name";
  const columns = [
    { id: "account_name", label: "Account", type: "string", nullable: true },
    { id: "n", label: "Count", type: "integer", nullable: true },
  ];

  afterAll(async () => {
    await closeAnalysisPool();
  });

  /**
   * A saved analysis as the move to SQLite left it: version 1 holds custom
   * SQL with the PostgreSQL dialect. Versions are immutable, so the fixture
   * inserts the rows.
   */
  async function createPostgresqlAnalysis(name: string) {
    const id = randomUUID();
    const definitionId = `analysis:${randomUUID()}`;
    const definition = buildDefinition({
      definitionId,
      version: 1,
      name,
      workspace: "budgeting",
      parameters: {},
      querySpec: { mode: "sql", sql: pgSql, datasetIds: ["accounts"], columns },
    });
    const legacy = {
      ...definition,
      source: { ...definition.source, dialect: "postgresql" },
    };
    const pool = getTestPool();
    await pool.query(
      `INSERT INTO saved_analyses (id, definition_id, name, workspace, current_version)
       VALUES ($1, $2, $3, 'budgeting', 1)`,
      [id, definitionId, name],
    );
    await pool.query(
      `INSERT INTO saved_analysis_definition_versions (saved_analysis_id, version, definition_json, state_json)
       VALUES ($1, 1, vision_jsonb($2), vision_jsonb($3))`,
      [
        id,
        JSON.stringify(legacy),
        JSON.stringify({ parameters: {}, charts: [], sourceReferences: [], refreshMode: "live" }),
      ],
    );
    return id;
  }

  it("flags it for review in the list and the detail, and refuses to run it", async () => {
    const id = await createPostgresqlAnalysis("Legacy SQL");
    const detail = must(await getSavedAnalysis(id), "detail");
    expect(detail).toMatchObject({
      needsReview: true,
      reviewReason: "postgresql-custom-sql",
      refreshStatus: "never-run",
    });
    // The SQL is kept unchanged.
    expect((detail.definition.source as AnalysisCustomSqlSource).text).toBe(pgSql);
    const listed = (await listSavedAnalyses("budgeting")).find((item) => item.id === id);
    expect(listed).toMatchObject({ needsReview: true, reviewReason: "postgresql-custom-sql" });

    await expect(runSavedAnalysis(id)).rejects.toMatchObject({
      status: 409,
      code: ANALYSIS_SQL_NEEDS_REVIEW,
    });
    // Nothing ran: no run row, and the refresh state is untouched.
    const runs = await getTestPool().query<{ n: number }>(
      "SELECT count(*) AS n FROM saved_analysis_runs WHERE saved_analysis_id = $1",
      [id],
    );
    expect(runs.rows).toEqual([{ n: 0 }]);
    expect(must(await getSavedAnalysis(id), "after").refreshStatus).toBe("never-run");
  });

  it("clears the flag when the user saves a SQLite version, keeping the PostgreSQL text in history", async () => {
    const id = await createPostgresqlAnalysis("Reviewed SQL");
    await getTestPool().query(
      "INSERT INTO accounts (name, currency) VALUES ('Reviewed account', 'EUR')",
    );
    const sqliteSql =
      "SELECT account_name, count(*) AS n FROM vision_analysis.accounts_v1 WHERE account_name = 'Reviewed account' GROUP BY account_name";
    const updated = must(
      await updateSavedAnalysis(id, {
        expectedVersion: 1,
        querySpec: { mode: "sql", sql: sqliteSql, datasetIds: ["accounts"], columns },
      }),
      "updated",
    );
    expect(updated).toMatchObject({ version: 2, needsReview: false, reviewReason: null });
    expect((updated.definition.source as AnalysisCustomSqlSource).dialect).toBe("sqlite");

    const ran = must(await runSavedAnalysis(id), "ran");
    expect(ran.refreshStatus).toBe("succeeded");
    expect(ran.lastResult).toMatchObject({
      rows: [{ account_name: "Reviewed account", n: 1 }],
    });
    const versions = await listSavedAnalysisVersions(id);
    expect(
      versions.map((version) => [
        version.version,
        (version.definition.source as AnalysisCustomSqlSource).dialect,
        (version.definition.source as AnalysisCustomSqlSource).text,
      ]),
    ).toEqual([
      [2, "sqlite", sqliteSql],
      [1, "postgresql", pgSql],
    ]);
  });

  it("never flags a visual analysis", async () => {
    const created = must(
      await createSavedAnalysis({
        name: "Visual accounts",
        workspace: "budgeting",
        querySpec: {
          mode: "visual",
          plan: {
            datasetId: "accounts",
            fields: ["account_name"],
            groups: [],
            measures: [],
            filters: [],
            joins: [],
            orderBy: [],
            limit: 50,
          },
        },
        parameters: {},
      }),
      "created",
    );
    expect(created).toMatchObject({ needsReview: false, reviewReason: null });
    expect(must(await runSavedAnalysis(created.id), "ran").refreshStatus).toBe("succeeded");
  });
});
