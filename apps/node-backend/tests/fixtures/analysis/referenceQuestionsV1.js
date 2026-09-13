const capturedAt = "2026-09-12T09:00:00.000Z";
const reportingMoney = {
  kind: "money",
  currencyParameterId: "currency",
  scale: 2,
};
const ratio = { kind: "percentage", percentageBasis: "ratio", scale: 4 };

const reportingParameters = [
  {
    id: "currency",
    label: "Reporting currency",
    type: "currency",
    required: true,
    defaultValue: "EUR",
    sensitive: false,
  },
  {
    id: "timezone",
    label: "Reporting timezone",
    type: "string",
    required: true,
    defaultValue: "Europe/Helsinki",
    sensitive: false,
  },
  {
    id: "date_from",
    label: "From",
    type: "date",
    required: true,
    defaultValue: "2026-01-01",
    sensitive: false,
  },
  {
    id: "date_to",
    label: "To",
    type: "date",
    required: true,
    defaultValue: "2026-12-31",
    sensitive: false,
  },
];

function column(id, label, type = "string", extra = {}) {
  return { id, label, type, nullable: false, ...extra };
}
function records(datasetId, entity, ids, source) {
  return {
    kind: "records",
    datasetId,
    records: ids.map((id) => ({ entity, id, ...(source ? { source } : {}) })),
  };
}
function metric(id, label, version, unit, dependencies = []) {
  return {
    id,
    label,
    kind: "metric",
    expression: id,
    resultType: "decimal",
    languageVersion: "vision-metric-v1",
    metricVersion: version,
    dependencies,
    ...(unit
      ? { unit, rounding: { mode: "half-even", scale: unit.scale ?? 4 } }
      : {}),
  };
}
function formula(id, label, unit, dependencies) {
  return {
    id,
    label,
    kind: "formula",
    expression: dependencies.join(" * "),
    resultType: "decimal",
    languageVersion: "vision-formula-v1",
    dependencies,
    unit,
    rounding: { mode: "half-even", scale: unit.scale ?? 2 },
  };
}

const documentSource = {
  providerId: "sec-edgar",
  sourceId: "filing:2026-q2",
  sourceVersion: "2026-q2-amended",
  asOf: capturedAt,
  contentHash: "a".repeat(64),
  uri: "https://www.sec.gov/Archives/example",
  passageId: "risk-factors:p42",
};

const cases = [
  {
    id: "budget-category-change-transfer-refund",
    workspace: "budgeting",
    question: "Explain a category increase after transfers and refunds",
    datasets: ["transactions", "transfer_links", "refund_links"],
    columns: [
      column("category", "Category"),
      column("gross_spend", "Gross spend", "decimal", { unit: reportingMoney }),
      column("refunds", "Refunds", "decimal", { unit: reportingMoney }),
      column("net_flow", "Net category flow", "decimal", {
        unit: reportingMoney,
        calculationId: "net_flow",
        calculationVersion: "transfer-refund-v1",
      }),
      column("transfer_excluded", "Transfer excluded", "boolean"),
    ],
    calculations: [
      metric(
        "net_flow",
        "Net category flow after refunds, excluding transfers",
        "transfer-refund-v1",
        reportingMoney,
      ),
    ],
    calculationValues: { net_flow: "-395" },
    rows: [
      {
        id: "groceries",
        values: {
          category: "Groceries",
          gross_spend: "-420",
          refunds: "25",
          net_flow: "-395",
          transfer_excluded: true,
        },
        lineage: [
          records("transactions", "transaction", ["expense-1", "refund-1"]),
          records("transfer_links", "transfer", ["transfer-1"]),
          records("refund_links", "refund", ["refund-1"]),
        ],
      },
    ],
  },
  {
    id: "budget-recurring-vs-discretionary",
    workspace: "budgeting",
    question: "Compare recurring and discretionary costs",
    datasets: ["transactions", "recurrence_classifications"],
    columns: [
      column("classification", "Classification"),
      column("amount", "Amount", "decimal", { unit: reportingMoney }),
    ],
    rows: [
      {
        id: "recurring",
        values: { classification: "recurring", amount: "950" },
        lineage: [
          records("transactions", "transaction", ["rent-1"]),
          records("recurrence_classifications", "classification", ["rent-1"]),
        ],
      },
      {
        id: "discretionary",
        values: { classification: "discretionary", amount: "275" },
        lineage: [
          records("transactions", "transaction", ["dining-1"]),
          records("recurrence_classifications", "classification", ["dining-1"]),
        ],
      },
    ],
  },
  {
    id: "budget-contract-comparison",
    workspace: "budgeting",
    question: "Compare two contracts with editable assumptions",
    datasets: ["contract_payments"],
    columns: [
      column("contract", "Contract"),
      column("actual_paid", "Actual paid", "decimal", { unit: reportingMoney }),
    ],
    assumptions: [
      {
        id: "monthly_price",
        label: "Monthly price",
        type: "decimal",
        defaultValue: "40",
        editable: true,
        source: "user",
        unit: reportingMoney,
      },
      {
        id: "months",
        label: "Months",
        type: "integer",
        defaultValue: 12,
        editable: true,
        source: "user",
      },
    ],
    calculations: [
      formula("scenario_total", "Scenario total", reportingMoney, [
        "monthly_price",
        "months",
      ]),
    ],
    calculationValues: { scenario_total: "480" },
    rows: [
      {
        id: "contract-a",
        values: { contract: "A", actual_paid: "480" },
        lineage: [records("contract_payments", "contract", ["A"])],
      },
      {
        id: "contract-b",
        values: { contract: "B", actual_paid: "540" },
        lineage: [records("contract_payments", "contract", ["B"])],
      },
    ],
  },
  {
    id: "portfolio-total-return-vs-cash-income",
    workspace: "portfolio",
    question: "Compare total return and cash income in one currency",
    datasets: ["portfolio_transactions", "positions", "fx_rates"],
    columns: [
      column("measure", "Measure"),
      column("value", "Value", "decimal", { unit: reportingMoney }),
      column("source_currency", "Source currency", "currency"),
      column("fx_basis", "FX basis"),
      column("cost_basis_method", "Cost-basis method"),
    ],
    calculations: [
      metric(
        "total_return",
        "Total return",
        "portfolio-return-v3",
        reportingMoney,
      ),
      metric("cash_income", "Cash income", "cash-income-v2", reportingMoney),
    ],
    calculationValues: { total_return: "265.2", cash_income: "50" },
    canonicalPortfolioInput: [
      {
        id: 1,
        type: "buy",
        date: "2026-01-10",
        units: 10,
        amount: 1000,
        fees: 5,
        taxes: 0,
        fxMultiplier: "0.9",
      },
      {
        id: 2,
        type: "buy",
        date: "2026-02-10",
        units: 10,
        amount: 1100,
        fees: 5,
        taxes: 0,
        fxMultiplier: "0.92",
      },
      {
        id: 3,
        type: "sell",
        date: "2026-03-10",
        units: 10,
        amount: 1200,
        fees: 10,
        taxes: 5,
        fxMultiplier: "0.95",
      },
    ],
    canonicalPortfolioExpected: {
      realizedGain: "130",
      realizedGainReporting: "165.2",
      remainingCostReporting: "960.55",
    },
    rows: [
      {
        id: "total-return",
        values: {
          measure: "total_return",
          value: "265.2",
          source_currency: "USD",
          fx_basis: "transaction-date-and-current",
          cost_basis_method: "weighted_avg-v1",
        },
        lineage: [
          records("portfolio_transactions", "transaction", [
            "buy-usd-1",
            "buy-usd-2",
            "partial-sale-usd",
          ]),
          records("positions", "position", ["position-1"]),
          records("fx_rates", "rate", [
            "usd-eur-buy-1",
            "usd-eur-buy-2",
            "usd-eur-sale",
            "usd-eur-current",
          ]),
        ],
      },
      {
        id: "cash-income",
        values: {
          measure: "cash_income",
          value: "50",
          source_currency: "USD",
          fx_basis: "payment-date",
          cost_basis_method: "weighted_avg-v1",
        },
        lineage: [
          records("portfolio_transactions", "transaction", ["dividend-usd"]),
          records("fx_rates", "rate", ["usd-eur-dividend"]),
        ],
      },
      {
        id: "realized-gain",
        values: {
          measure: "realized_gain_component",
          value: "165.2",
          source_currency: "USD",
          fx_basis: "transaction-date",
          cost_basis_method: "weighted_avg-v1",
        },
        lineage: [
          records("portfolio_transactions", "transaction", [
            "buy-usd-1",
            "buy-usd-2",
            "partial-sale-usd",
          ]),
          records("fx_rates", "rate", [
            "usd-eur-buy-1",
            "usd-eur-buy-2",
            "usd-eur-sale",
          ]),
        ],
      },
      {
        id: "remaining-cost",
        values: {
          measure: "remaining_cost_basis",
          value: "960.55",
          source_currency: "USD",
          fx_basis: "purchase-date",
          cost_basis_method: "weighted_avg-v1",
        },
        lineage: [
          records("portfolio_transactions", "transaction", [
            "buy-usd-1",
            "buy-usd-2",
            "partial-sale-usd",
          ]),
          records("fx_rates", "rate", ["usd-eur-buy-1", "usd-eur-buy-2"]),
        ],
      },
    ],
    presentationKind: "bar",
    dimensions: [{ id: "fx_fallback", status: "complete", sources: [] }],
  },
  {
    id: "portfolio-etf-overlap-coverage",
    workspace: "portfolio",
    question: "Calculate ETF overlap and disclose unknown exposure",
    datasets: ["fund_holdings", "positions"],
    columns: [
      column("constituent", "Constituent"),
      column("covered_weight", "Covered weight", "decimal", { unit: ratio }),
      column("unknown_weight", "Unknown weight", "decimal", { unit: ratio }),
    ],
    rows: [
      {
        id: "US0378331005",
        values: {
          constituent: "US0378331005",
          covered_weight: "0.0842",
          unknown_weight: "0.12",
        },
        lineage: [
          records("fund_holdings", "holding", ["etf-a:apple", "etf-b:apple"]),
          records("positions", "position", ["etf-a", "etf-b"]),
        ],
      },
    ],
    partial: true,
    dimensions: [
      {
        id: "fund_weight",
        status: "partial",
        reasonCode: "uncovered-weight",
        detail: "12 percent of fund weight is unavailable",
        missingRatio: "0.12",
        sources: [],
      },
    ],
  },
  {
    id: "portfolio-hypothetical-contribution",
    workspace: "portfolio",
    question: "Explore a contribution without ledger writes",
    datasets: ["portfolio_positions"],
    columns: [
      column("target", "Target"),
      column("scenario_value", "Scenario value", "decimal", {
        unit: reportingMoney,
        calculationId: "scenario_value",
        calculationVersion: "vision-formula-v1",
      }),
    ],
    assumptions: [
      {
        id: "contribution",
        label: "Hypothetical contribution",
        type: "decimal",
        defaultValue: "500",
        editable: true,
        source: "user",
        unit: reportingMoney,
      },
    ],
    calculations: [
      formula("scenario_value", "Scenario value", reportingMoney, [
        "contribution",
      ]),
    ],
    calculationValues: { scenario_value: "500" },
    rows: [
      {
        id: "global-equity",
        values: { target: "global_equity", scenario_value: "500" },
        lineage: [
          records("portfolio_positions", "position", ["global-equity"]),
        ],
      },
    ],
  },
  {
    id: "research-filing-version-diff",
    workspace: "research",
    question: "Compare a filing with its prior version and cite passages",
    datasets: ["documents", "document_versions"],
    columns: [
      column("version", "Version"),
      column("passage", "Passage"),
      column("change", "Change"),
    ],
    rows: [
      {
        id: "prior",
        values: {
          version: "2026-q2",
          passage: "risk-factors:p42",
          change: "Baseline risk language",
        },
        lineage: [
          records("documents", "passage", ["prior:p42"], {
            ...documentSource,
            sourceVersion: "2026-q2",
          }),
          records("document_versions", "version-link", ["q2-to-amended"]),
        ],
      },
      {
        id: "amended",
        values: {
          version: "2026-q2-amended",
          passage: "risk-factors:p42",
          change: "Risk language expanded",
        },
        lineage: [
          records("documents", "passage", ["amended:p42"], documentSource),
          records("document_versions", "version-link", ["q2-to-amended"]),
        ],
      },
    ],
  },
  {
    id: "research-evidence-link",
    workspace: "research",
    question: "Connect cited evidence to a position and budget topic",
    datasets: ["documents", "positions", "budget_categories"],
    columns: [column("topic", "Topic"), column("evidence", "Evidence")],
    rows: [
      {
        id: "position",
        values: { topic: "position:42", evidence: "risk-factors:p42" },
        lineage: [
          records("documents", "passage", ["amended:p42"], documentSource),
          records("positions", "position", ["42"]),
        ],
      },
      {
        id: "budget",
        values: { topic: "budget:energy", evidence: "risk-factors:p42" },
        lineage: [
          records("documents", "passage", ["amended:p42"], documentSource),
          records("budget_categories", "category", ["energy"]),
        ],
      },
    ],
  },
  {
    id: "research-contradiction-unavailable",
    workspace: "research",
    question: "Identify contradictory and unavailable research sources",
    datasets: ["documents", "research_providers"],
    columns: [
      column("source", "Source"),
      column("claim", "Claim"),
      column("source_status", "Source status"),
    ],
    rows: [
      {
        id: "source-a",
        values: {
          source: "filing",
          claim: "Revenue outlook improved",
          source_status: "supports",
        },
        lineage: [
          records("documents", "passage", ["amended:p42"], documentSource),
        ],
      },
      {
        id: "source-b",
        values: {
          source: "provider-b",
          claim: "Revenue outlook weakened",
          source_status: "contradicts",
        },
        lineage: [
          records("research_providers", "provider-result", [
            "provider-b:claim-1",
          ]),
        ],
      },
    ],
    partial: true,
    dimensions: [
      {
        id: "provider-c",
        status: "unavailable",
        reasonCode: "provider-timeout",
        detail: "Third source did not respond",
        sources: [],
      },
    ],
  },
  {
    id: "cross-mode-roundtrip",
    workspace: "cross-workspace",
    question:
      "Preserve custom SQL across edit, undo, save, reopen, and refresh",
    datasets: ["transactions"],
    parameters: [
      {
        id: "minimum_rank",
        label: "Minimum rank",
        type: "integer",
        required: true,
        defaultValue: 0,
        sensitive: false,
      },
      {
        id: "multiplier",
        label: "Formula multiplier",
        type: "decimal",
        required: true,
        defaultValue: "1",
        sensitive: false,
      },
    ],
    calculations: [
      formula("adjusted_amount", "Adjusted amount", reportingMoney, [
        "amount",
        "multiplier",
      ]),
    ],
    calculationValues: { adjusted_amount: "725.25" },
    columns: [
      column("month", "Month", "date"),
      column("amount", "Amount", "decimal", { unit: reportingMoney }),
      column("adjusted_amount", "Adjusted amount", "decimal", {
        unit: reportingMoney,
        calculationId: "adjusted_amount",
        calculationVersion: "vision-formula-v1",
      }),
    ],
    rows: [
      {
        id: "2026-08",
        values: {
          month: "2026-08-01",
          amount: "725.25",
          adjusted_amount: "725.25",
        },
        lineage: [records("transactions", "transaction", ["august-aggregate"])],
      },
    ],
    visualFilters: [
      {
        left: {
          kind: "field",
          datasetId: "transactions",
          columnId: "transaction_rank",
        },
        operator: "gt",
        right: { kind: "parameter", id: "minimum_rank" },
      },
    ],
    sqlParameterIds: ["multiplier", "minimum_rank"],
    customSql:
      "-- :comment is not a binding\nSELECT month, amount, amount * :multiplier AS adjusted_amount\nFROM transactions_analysis\nWHERE transaction_rank::int > :minimum_rank AND ':literal' = ':literal'\n",
  },
];

function makeDefinition(item) {
  const parameters = [...reportingParameters, ...(item.parameters ?? [])];
  const calculations = item.calculations ?? [];
  const visualPlan = {
    kind: "visual-plan",
    planVersion: 1,
    datasetId: item.datasets[0],
    select: item.columns
      .filter((value) => {
        if (value.calculationId === undefined) return true;
        return (
          calculations.find(
            (calculation) => calculation.id === value.calculationId,
          )?.kind === "metric"
        );
      })
      .map((value) => ({
        id: value.id,
        source: value.calculationId
          ? { kind: "metric", calculationId: value.calculationId }
          : { kind: "field", datasetId: item.datasets[0], columnId: value.id },
      })),
    joins: item.datasets.slice(1).map((datasetId) => ({
      datasetId,
      type: "left",
      pathId: `${item.datasets[0]}:${datasetId}`,
    })),
    filters: item.visualFilters ?? [],
    groupBy: [],
    orderBy: [],
  };
  const source = item.customSql
    ? {
        kind: "custom-sql",
        dialect: "postgresql",
        text: item.customSql,
        datasetIds: item.datasets,
        parameterBindings: item.sqlParameterIds.map((parameterId) => {
          const start = item.customSql.indexOf(`:${parameterId}`);
          return {
            parameterId,
            startCodeUnit: start,
            endCodeUnit: start + parameterId.length + 1,
          };
        }),
        visualConversion: {
          status: "convertible",
        },
        visualOrigin: visualPlan,
      }
    : visualPlan;
  return {
    contractVersion: 1,
    definitionId: item.id,
    definitionVersion: 1,
    name: item.question,
    workspace: item.workspace,
    datasets: item.datasets.map((id) => ({
      id,
      schemaVersion: 1,
      requiredColumns: [],
      authorizationScope: "current-user",
    })),
    source,
    parameters,
    calculations,
    assumptions: item.assumptions ?? [],
    presentations: [
      item.presentationKind === "bar"
        ? {
            id: "primary_chart",
            kind: "bar",
            bindings: { x: "measure", y: ["value"] },
            requires: { columns: item.columns, completeResult: !item.partial },
          }
        : {
            id: "primary_grid",
            kind: "grid",
            bindings: { columns: item.columns.map((value) => value.id) },
            requires: { columns: item.columns, completeResult: !item.partial },
          },
    ],
    expectedResult: { columns: item.columns },
    reporting: {
      currencyParameterId: "currency",
      timezoneParameterId: "timezone",
      dateFromParameterId: "date_from",
      dateToParameterId: "date_to",
    },
  };
}

function makeResult(item, definition) {
  const partial = item.partial === true;
  return {
    contractVersion: 1,
    runId: `run:${item.id}`,
    definitionRef: {
      definitionId: definition.definitionId,
      definitionVersion: definition.definitionVersion,
    },
    status: partial ? "partial" : "completed",
    startedAt: capturedAt,
    completedAt: "2026-09-12T09:00:01.000Z",
    execution: {
      executorId: "fixture-executor",
      executorVersion: "1",
      queryMode: item.customSql ? "custom-sql" : "visual-plan",
      durationMs: 1000,
      snapshot: {
        consistency: "frozen-inputs",
        id: `snapshot:${item.id}`,
        capturedAt,
      },
      effectiveParameters: {
        currency: "EUR",
        timezone: "Europe/Helsinki",
        date_from: "2026-01-01",
        date_to: "2026-12-31",
        ...Object.fromEntries(
          (item.parameters ?? []).map((value) => [
            value.id,
            value.defaultValue,
          ]),
        ),
      },
      effectiveAssumptions: Object.fromEntries(
        (item.assumptions ?? []).map((value) => [value.id, value.defaultValue]),
      ),
    },
    reporting: {
      currency: "EUR",
      timezone: "Europe/Helsinki",
      dateRange: { from: "2026-01-01", to: "2026-12-31", bounds: "inclusive" },
    },
    sourceVersions: item.datasets.map((datasetId) => ({
      datasetId,
      schemaVersion: 1,
      revision: `${datasetId}-fixture-v1`,
      capturedAt,
    })),
    calculationResults: (item.calculations ?? []).map((calculation) => ({
      id: calculation.id,
      status: "ok",
      kind: calculation.kind,
      version:
        calculation.kind === "metric"
          ? calculation.metricVersion
          : calculation.languageVersion,
      type: calculation.resultType,
      ...(calculation.unit ? { unit: calculation.unit } : {}),
      value: item.calculationValues[calculation.id],
    })),
    coverage: {
      status: partial ? "partial" : "complete",
      datasets: item.datasets.map((id) => ({
        id,
        status: "complete",
        sources: [],
      })),
      dimensions: item.dimensions ?? [],
      warnings: partial
        ? [
            {
              code: "incomplete-coverage",
              message: "Missing data remains explicit and is not renormalized",
              affectedColumns: [item.columns.at(-1).id],
            },
          ]
        : [],
    },
    data: {
      schemaVersion: 1,
      rowGrain: {
        id: "fixture-row",
        description: "Acceptance-question result grain",
        keys: [item.columns[0].id],
      },
      columns: item.columns,
      rows: item.rows,
      window: { kind: "complete", totalRows: item.rows.length },
    },
  };
}

export const ANALYSIS_REFERENCE_QUESTIONS_V1 = cases.map((item) => {
  const definition = makeDefinition(item);
  const result = makeResult(item, definition);
  if (item.id !== "cross-mode-roundtrip")
    return {
      id: item.id,
      question: item.question,
      definition,
      result,
      ...(item.canonicalPortfolioInput
        ? {
            canonicalPortfolioInput: item.canonicalPortfolioInput,
            canonicalPortfolioExpected: item.canonicalPortfolioExpected,
          }
        : {}),
    };
  const visualDefinition = {
    ...structuredClone(definition),
    definitionVersion: 2,
    source: structuredClone(definition.source.visualOrigin),
  };
  const visualResult = {
    ...structuredClone(result),
    runId: "run:cross-mode-roundtrip:visual",
    definitionRef: {
      definitionId: visualDefinition.definitionId,
      definitionVersion: visualDefinition.definitionVersion,
    },
    execution: {
      ...structuredClone(result.execution),
      queryMode: "visual-plan",
    },
  };
  const advancedSql =
    "-- preserve byte-for-byte; :comment is not a binding\nWITH ranked AS (\n  SELECT month, amount::numeric, row_number() OVER (ORDER BY month) AS n, $$:body$$ AS marker\n  FROM transactions_analysis\n  WHERE ':literal' = ':literal'\n)\nSELECT month, amount, amount * :multiplier AS adjusted_amount FROM ranked WHERE n > :minimum_rank\n";
  const nonConvertibleDefinition = {
    ...structuredClone(definition),
    definitionVersion: 3,
    source: {
      ...structuredClone(definition.source),
      text: advancedSql,
      parameterBindings: ["multiplier", "minimum_rank"].map((parameterId) => {
        const start = advancedSql.indexOf(`:${parameterId}`);
        return {
          parameterId,
          startCodeUnit: start,
          endCodeUnit: start + parameterId.length + 1,
        };
      }),
      visualConversion: {
        status: "unsupported",
        reasonCode: "window-function",
      },
    },
  };
  return {
    id: item.id,
    question: item.question,
    definition,
    result,
    visualDefinition,
    visualResult,
    nonConvertibleDefinition,
  };
});
