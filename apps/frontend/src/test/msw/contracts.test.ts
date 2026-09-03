/**
 * Contract tests — validate MSW default handler fixture shapes against
 * the shapes the real backend returns.
 *
 * A failure here means a mock drifted from the backend contract.
 * Fix the handler fixture to match the real shape — never weaken the schema.
 *
 * Schemas are derived from:
 *   - openapi.yaml  (categories, recipients, transactions, planned-transactions, investments)
 *   - backend source (exchange-rates, market/news, import/batches, portfolio/summary)
 *   - ADR-026       (envelope: { ok: true, data } / { ok: false, error: { message } })
 *
 * The MSW server is started globally by src/test-setup.ts (setupFiles).
 * This file runs in the node environment (no jsdom needed).
 */
import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { z } from "zod";
import { server } from "./server";
import {
    CategoryItemSchema,
    collectionSchema,
    InvestmentItemSchema,
    LinkSchema,
    paginatedOf,
    PlannedTransactionItemSchema,
    RecipientItemSchema,
    TransactionItemSchema,
} from "@/test/contracts/schemas";
import {
    TRANSACTION_STUB,
    CATEGORY_STUB,
    RECIPIENT_STUB,
    INVESTMENT_STUB,
    PLANNED_TRANSACTION_STUB,
    importCsvReviewRequiredHandlers,
} from "./handlers";

const BASE = "http://localhost:3002";

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * The status code is part of the contract, not decoration. `res.ok` (any 2xx)
 * cannot tell a 200 from a 201, so a route that quietly changed its status
 * would sail past a body-only assertion — the same defect class as the body
 * drift these tests exist to catch, one layer down. Both helpers below assert
 * an EXACT status; mutation rows carry theirs as a table column, derived from
 * the express route's `res.status(...)` call (or its absence, which means 200).
 *
 * Every GET route in this file reaches the wire through a bare `res.ok(...)`
 * with no preceding `res.status(...)`, so 200 is pinned here rather than
 * repeated as an identical column across ~60 rows. A GET that ever needs a
 * different code should take the second argument.
 */
async function getEnvelope(
    path: string,
    expectedStatus = 200,
): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`);
    expect(res.status, `expected ${expectedStatus} for GET ${path}`).toBe(
        expectedStatus,
    );
    const json = (await res.json()) as { ok: boolean; data: unknown };
    expect(json.ok, `envelope.ok false for ${path}`).toBe(true);
    return json.data;
}

async function mutateEnvelope(
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    expectedStatus = 200,
): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    expect(res.status, `expected ${expectedStatus} for ${method} ${path}`).toBe(
        expectedStatus,
    );
    const json = (await res.json()) as { ok: boolean; data: unknown };
    expect(json.ok, `envelope.ok false for ${method} ${path}`).toBe(true);
    return json.data;
}

/**
 * Assert a hard delete answers 204 No Content with a genuinely empty body —
 * the repo-wide DELETE convention (docs/reference/code-patterns.md, "DELETE
 * responses"). A 204 carries no ADR-026 envelope, so there is nothing to
 * schema-validate; the contract IS the absence of a body.
 */
async function expectNoContent(path: string): Promise<void> {
    const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
    expect(res.status, `expected 204 for DELETE ${path}`).toBe(204);
    expect(await res.text(), `expected empty body for DELETE ${path}`).toBe("");
}

function validate<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
    const result = schema.safeParse(data);
    if (!result.success) {
        throw new Error(
            `Contract violation [${label}]:\n${result.error.toString()}`,
        );
    }
    return result.data;
}

describe("shared contract schema strictness", () => {
    it("rejects unknown resource and envelope fields", () => {
        expect(
            CategoryItemSchema.safeParse({
                ...CATEGORY_STUB,
                unexpected: true,
            }).success,
        ).toBe(false);
        expect(
            collectionSchema().safeParse({
                items: [],
                total: 0,
                unexpected: true,
            }).success,
        ).toBe(false);
        expect(
            paginatedOf(CategoryItemSchema).safeParse({
                items: [],
                total: 0,
                limit: 10,
                offset: 0,
                links: [],
                unexpected: true,
            }).success,
        ).toBe(false);
    });
});

// ── ADR-026 error envelope ────────────────────────────────────────────────────

const ErrorEnvelopeSchema = z.object({
    ok: z.literal(false),
    error: z.object({
        message: z.string(),
        code: z.string().optional(),
    }),
});

// ── Other endpoint schemas ────────────────────────────────────────────────────

const SettingsSchema = z.record(z.string(), z.unknown());
const SettingValueSchema = z.unknown();

const InfoSchema = z.object({
    version: z.string(),
    commit: z.string(),
    buildDate: z.string(),
});

const HealthSchema = z.object({ status: z.string() });

const ExchangeRateItemSchema = z.object({
    currency: z.string(),
    rate_to_eur: z.number(),
    rate_date: z.string(),
    fetched_at: z.string(),
});
const ExchangeRatesSchema = z.object({
    rates: z.array(ExchangeRateItemSchema),
    fallback_rates: z.record(z.string(), z.unknown()),
    base: z.string(),
    date: z.string(),
});

const NewsArticleSchema = z.object({
    title: z.string(),
    link: z.string(),
    publisher: z.string(),
    publishedAt: z.number().nullable(),
    thumbnail: z.string().nullable(),
    relatedSymbols: z.array(z.string()),
});
// Canonical `{ items, total }` collection body.
const MarketNewsSchema = z.object({
    items: z.array(NewsArticleSchema),
    total: z.number().int().nonnegative(),
});

// Canonical collection body: { items, total, limit, offset }.
const ImportBatchesSchema = z.object({
    items: z.array(z.object({}).passthrough()),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
});

/** `{ items, total }` — the canonical body for unpaginated collection GETs. */
const PortfolioTotalsSchema = z.object({
    totalPortfolioValue: z.number(),
    totalInvested: z.number(),
    totalGainLoss: z.number(),
    totalRealizedGain: z.number(),
    totalUnrealizedGain: z.number(),
    totalGain: z.number(),
    totalIncome: z.number(),
    totalFees: z.number(),
    totalTaxes: z.number(),
    totalReturnPct: z.number(),
});
const PortfolioSummarySchema = z.object({
    currency: z.string(),
    computed_at: z.string(),
    totals: PortfolioTotalsSchema,
    summaries: z.array(z.object({}).passthrough()),
});

// ── Tests: static GET endpoints ───────────────────────────────────────────────

describe("MSW handler contracts", () => {
    it.each<[string, z.ZodTypeAny, string, string]>([
        [
            "GET /api/settings conforms to settings schema",
            SettingsSchema,
            "/api/settings",
            "settings",
        ],
        [
            "GET /api/settings/:key conforms to nullable value schema",
            SettingValueSchema,
            "/api/settings/language",
            "settings/:key",
        ],
        [
            "GET /api/info conforms to app-info schema",
            InfoSchema,
            "/api/info",
            "info",
        ],
        [
            "GET /api/info/health conforms to health schema",
            HealthSchema,
            "/api/info/health",
            "health",
        ],
        [
            "GET /api/aggregations/:name accepts nullable blob",
            z.unknown(),
            "/api/aggregations/monthly",
            "aggregations/:name",
        ],
        [
            "GET /api/info/exchange-rates conforms to rates schema",
            ExchangeRatesSchema,
            "/api/info/exchange-rates",
            "exchange-rates",
        ],
        [
            "GET /api/market/news conforms to news schema",
            MarketNewsSchema,
            "/api/market/news",
            "market/news",
        ],
        [
            "GET /api/import/batches conforms to batches schema",
            ImportBatchesSchema,
            "/api/import/batches",
            "import/batches",
        ],
        [
            "GET /api/portfolio/summary conforms to portfolio-summary schema",
            PortfolioSummarySchema,
            "/api/portfolio/summary",
            "portfolio/summary",
        ],
        [
            "GET /api/admin/endpoint-liveness conforms to collection schema",
            collectionSchema(),
            "/api/admin/endpoint-liveness",
            "admin/endpoint-liveness",
        ],
        [
            "GET /api/planned conforms to array schema",
            z.array(z.unknown()),
            "/api/planned",
            "planned",
        ],
    ])("%s", async (_name, schema, path, label) => {
        validate(schema, await getEnvelope(path), label);
    });
});

// ── E1: Strict list item schemas ──────────────────────────────────────────────

describe("GET list endpoints — strict item schemas (E1)", () => {
    describe.each<[string, z.ZodTypeAny, Record<string, unknown>, number]>([
        ["/api/categories", CategoryItemSchema, CATEGORY_STUB, 200],
        ["/api/recipients", RecipientItemSchema, RECIPIENT_STUB, 200],
        ["/api/transactions", TransactionItemSchema, TRANSACTION_STUB, 50],
        [
            "/api/planned-transactions",
            PlannedTransactionItemSchema,
            PLANNED_TRANSACTION_STUB,
            1000,
        ],
        ["/api/investments", InvestmentItemSchema, INVESTMENT_STUB, 100],
    ])("%s", (path, ItemSchema, STUB, limit) => {
        it("empty list envelope is valid", async () => {
            validate(
                paginatedOf(ItemSchema),
                await getEnvelope(path),
                `${path} empty`,
            );
        });

        it("item shape matches schema", async () => {
            server.use(
                http.get(`${BASE}${path}`, () =>
                    HttpResponse.json({
                        ok: true,
                        data: {
                            items: [STUB],
                            total: 1,
                            limit,
                            offset: 0,
                            links: [],
                        },
                    }),
                ),
            );
            const data = await getEnvelope(path);
            const parsed = validate(
                paginatedOf(ItemSchema),
                data,
                `${path} item`,
            );
            expect(parsed.items).toHaveLength(1);
        });
    });
});

// ── E2: Mutation contract tests ───────────────────────────────────────────────

describe("Mutation handler contracts (E2)", () => {
    // Fourth column = the status the real POST answers. It is NOT uniform:
    // transactions/investments/planned-transactions call `res.status(201)`
    // before `res.ok(...)`, while categories and recipients do not and so
    // answer 200. Sources, in table order:
    //   routes/transactions.js:576            → 201
    //   routes/categories.js:53-59            → 200 (no res.status call)
    //   routes/recipients.js:77-89            → 200 (no res.status call)
    //   controllers/investmentController.js:389 → 201
    //   routes/plannedTransactions.js:443     → 201
    // Every PATCH in this table is a bare `res.ok(...)` → 200.
    describe.each<[string, string, z.ZodTypeAny, number]>([
        ["transactions", "/api/transactions", TransactionItemSchema, 201],
        ["categories", "/api/categories", CategoryItemSchema, 200],
        ["recipients", "/api/recipients", RecipientItemSchema, 200],
        ["investments", "/api/investments", InvestmentItemSchema, 201],
        [
            "planned-transactions",
            "/api/planned-transactions",
            PlannedTransactionItemSchema,
            201,
        ],
    ])("%s", (label, path, ItemSchema, createStatus) => {
        it(`POST ${path} answers ${createStatus} and matches item schema`, async () => {
            validate(
                ItemSchema,
                await mutateEnvelope("POST", path, {}, createStatus),
                `POST ${label}`,
            );
        });

        it(`PATCH ${path}/:id answers 200 and matches item schema`, async () => {
            validate(
                ItemSchema,
                await mutateEnvelope("PATCH", `${path}/1`, {}, 200),
                `PATCH ${label}`,
            );
        });

        it(`DELETE ${path}/:id answers 204 with no body`, async () => {
            await expectNoContent(`${path}/1`);
        });
    });

    // Hard deletes outside the five CRUD resources above. Same contract: 204,
    // empty body, no envelope.
    it.each([
        ["/api/accounts/1"],
        ["/api/ai/conversations/conv-1"],
        ["/api/attachments/1"],
        ["/api/investments/transactions/1"],
        ["/api/recipients/1/patterns/1"],
        ["/api/saved-charts/1"],
        ["/api/splits/1"],
        ["/api/watchlist/1"],
    ])("DELETE %s answers 204 with no body", async (path) => {
        await expectNoContent(path);
    });
});

// ── E3: Error envelope contract tests ────────────────────────────────────────

describe("ADR-026 error envelope (E3)", () => {
    it("500 error response conforms to { ok: false, error: { message } }", async () => {
        server.use(
            http.get(`${BASE}/api/categories`, () =>
                HttpResponse.json(
                    { ok: false, error: { message: "Internal server error" } },
                    { status: 500 },
                ),
            ),
        );
        const json = await fetch(`${BASE}/api/categories`).then((r) =>
            r.json(),
        );
        validate(ErrorEnvelopeSchema, json, "500 error envelope");
    });

    it("404 error response with optional code field conforms to schema", async () => {
        server.use(
            http.get(`${BASE}/api/transactions`, () =>
                HttpResponse.json(
                    {
                        ok: false,
                        error: { message: "Not found", code: "NOT_FOUND" },
                    },
                    { status: 404 },
                ),
            ),
        );
        const json = await fetch(`${BASE}/api/transactions`).then((r) =>
            r.json(),
        );
        validate(ErrorEnvelopeSchema, json, "404 error envelope with code");
    });

    it("422 mutation error response conforms to error envelope", async () => {
        server.use(
            http.post(`${BASE}/api/transactions`, () =>
                HttpResponse.json(
                    {
                        ok: false,
                        error: {
                            message: "Validation failed",
                            code: "VALIDATION_ERROR",
                        },
                    },
                    { status: 422 },
                ),
            ),
        );
        const json = await fetch(`${BASE}/api/transactions`, {
            method: "POST",
        }).then((r) => r.json());
        validate(ErrorEnvelopeSchema, json, "422 mutation error envelope");
    });

    it("503 error without code field still conforms to schema", async () => {
        server.use(
            http.get(`${BASE}/api/recipients`, () =>
                HttpResponse.json(
                    {
                        ok: false,
                        error: { message: "Database connection failed" },
                    },
                    { status: 503 },
                ),
            ),
        );
        const json = await fetch(`${BASE}/api/recipients`).then((r) =>
            r.json(),
        );
        validate(ErrorEnvelopeSchema, json, "503 error envelope without code");
    });
});

const aggregationsEnvelope = (dataSchema: z.ZodTypeAny) =>
    z.object({
        data: dataSchema,
        meta: z.object({
            computedAt: z.string(),
            source: z.enum(["live", "cache"]),
        }),
    });

describe("Missing GET endpoint contracts (E4)", () => {
    // The /api/info/* routes below return OBJECTS, not bare scalars/arrays —
    // schemas match the backend (routes/info/statistics.js) and the
    // live-contracts suite so the two contract suites can no longer assert
    // contradictory shapes.
    // (transaction-summary case removed — Phase 9 deleted that route.)
    it.each<[string, string, string, z.ZodTypeAny]>([
        [
            "GET /api/aggregations/monthly-summary returns expected shape",
            "/api/aggregations/monthly-summary",
            "GET /api/aggregations/monthly-summary",
            aggregationsEnvelope(
                z.object({
                    months: z.array(z.unknown()),
                    summary: z.object({
                        total_spending: z.number(),
                        total_income: z.number(),
                        net_amount: z.number(),
                        transaction_count: z.number(),
                        period_start: z.string(),
                        period_end: z.string(),
                    }),
                }),
            ),
        ],
        [
            "GET /api/aggregations/recipient-insights returns expected shape",
            "/api/aggregations/recipient-insights",
            "GET /api/aggregations/recipient-insights",
            aggregationsEnvelope(
                z.object({
                    topMerchants: z.array(z.unknown()),
                    monthOverMonth: z.array(z.unknown()),
                }),
            ),
        ],
        [
            "GET /api/import/batches returns expected shape",
            "/api/import/batches",
            "GET /api/import/batches",
            ImportBatchesSchema,
        ],
        [
            "GET /api/import/batches/:id/preview returns expected shape",
            "/api/import/batches/1/preview",
            "GET /api/import/batches/:id/preview",
            z.object({
                batch_id: z.number(),
                groups: z.array(z.unknown()),
                totals: z.object({
                    exact: z.number(),
                    fuzzy: z.number(),
                    pattern: z.number(),
                    new: z.number(),
                    unresolved: z.number(),
                }),
            }),
        ],
        [
            "GET /api/splits/owed returns { items, total }",
            "/api/splits/owed",
            "GET /api/splits/owed",
            collectionSchema(),
        ],
        [
            "GET /api/market/quote returns { items, total }",
            "/api/market/quote",
            "GET /api/market/quote",
            collectionSchema(),
        ],
        [
            "GET /api/market/search returns expected shape",
            "/api/market/search",
            "GET /api/market/search",
            z.object({ results: z.array(z.unknown()) }),
        ],
        [
            "GET /api/watchlist returns expected shape",
            "/api/watchlist",
            "GET /api/watchlist",
            z.object({
                items: z.array(z.unknown()),
                total: z.number(),
                limit: z.number(),
                offset: z.number(),
            }),
        ],
        [
            "GET /api/ai/status returns expected shape",
            "/api/ai/status",
            "GET /api/ai/status",
            z.object({
                ok: z.boolean(),
                baseUrl: z.string(),
                defaultModel: z.string(),
                enabled: z.boolean(),
            }),
        ],
        [
            "GET /api/ai/conversations returns { items, total }",
            "/api/ai/conversations",
            "GET /api/ai/conversations",
            collectionSchema(),
        ],
        [
            "GET /api/info/portfolio-performance returns expected shape",
            "/api/info/portfolio-performance",
            "GET /api/info/portfolio-performance",
            z.object({
                snapshots: z.array(z.unknown()),
                currency: z.string(),
                start_value: z.number(),
                end_value: z.number(),
                absolute_return: z.number(),
                percentage_return: z.number(),
            }),
        ],
        [
            "GET /api/info/net-worth returns expected shape",
            "/api/info/net-worth",
            "GET /api/info/net-worth",
            z.object({
                current: z.object({
                    liquid: z.number(),
                    investments: z.number(),
                    netWorth: z.number(),
                }),
                monthlyChange: z.number(),
                monthlyChangePercent: z.number(),
                snapshots: z.array(z.unknown()),
            }),
        ],
        [
            "GET /api/info/transaction-count returns { total_transactions }",
            "/api/info/transaction-count",
            "GET /api/info/transaction-count",
            z.object({ total_transactions: z.number() }),
        ],
        [
            "GET /api/info/recurring-patterns returns { patterns, total }",
            "/api/info/recurring-patterns",
            "GET /api/info/recurring-patterns",
            z.object({ patterns: z.array(z.unknown()), total: z.number() }),
        ],
        [
            "GET /api/info/banks returns { items, total }",
            "/api/info/banks",
            "GET /api/info/banks",
            collectionSchema(),
        ],
        [
            "GET /api/info/supported-adapters returns { items, total }",
            "/api/info/supported-adapters",
            "GET /api/info/supported-adapters",
            collectionSchema(),
        ],
        [
            "GET /api/info/inflation-rates returns array",
            "/api/info/inflation-rates",
            "GET /api/info/inflation-rates",
            z.array(z.unknown()),
        ],
        [
            "GET /api/admin/endpoint-liveness returns { items, total }",
            "/api/admin/endpoint-liveness",
            "GET /api/admin/endpoint-liveness",
            collectionSchema(),
        ],
        [
            "GET /api/admin/database/stats returns expected shape",
            "/api/admin/database/stats",
            "GET /api/admin/database/stats",
            z.object({ tables: z.array(z.unknown()), db_size: z.null() }),
        ],
        [
            "GET /api/admin/providers/health returns { items, total }",
            "/api/admin/providers/health",
            "GET /api/admin/providers/health",
            collectionSchema(),
        ],
        [
            "GET /api/admin/metrics/requests returns { items, total }",
            "/api/admin/metrics/requests",
            "GET /api/admin/metrics/requests",
            collectionSchema(),
        ],
        [
            "GET /api/admin/endpoints returns { items, total }",
            "/api/admin/endpoints",
            "GET /api/admin/endpoints",
            collectionSchema(),
        ],
    ])("%s", async (_name, path, label, schema) => {
        validate(schema, await getEnvelope(path), label);
    });
});

// ── E5: Phase F1 — full contract surface coverage ────────────────────────────

describe("Phase F1: extended GET endpoint contracts", () => {
    it.each<[string, string, string, z.ZodTypeAny]>([
        [
            "GET /api/admin/update/check returns update status",
            "/api/admin/update/check",
            "GET /api/admin/update/check",
            z.object({
                up_to_date: z.boolean(),
                current_version: z.string(),
                latest_version: z.string().nullable(),
                update_mode: z.literal("docker-compose"),
            }),
        ],
        [
            "GET /api/aggregations/cashflow-comparison returns expected shape",
            "/api/aggregations/cashflow-comparison",
            "GET /api/aggregations/cashflow-comparison",
            aggregationsEnvelope(
                z.object({
                    days_in_month: z.number(),
                    current_day: z.number(),
                    month: z.number(),
                    year: z.number(),
                    without_planned: z.array(z.unknown()),
                    with_planned: z.array(z.unknown()),
                }),
            ),
        ],
        [
            "GET /api/aggregations/cashflow-forecast-accuracy returns expected shape",
            "/api/aggregations/cashflow-forecast-accuracy",
            "GET /api/aggregations/cashflow-forecast-accuracy",
            aggregationsEnvelope(
                z.object({
                    methods: z.array(z.unknown()),
                    limit_months: z.number(),
                }),
            ),
        ],
        [
            "GET /api/aggregations/cashflow-forecast-methods returns expected shape",
            "/api/aggregations/cashflow-forecast-methods",
            "GET /api/aggregations/cashflow-forecast-methods",
            aggregationsEnvelope(
                z.object({
                    month: z.string(),
                    currency: z.string(),
                    days_in_month: z.number(),
                    current_day: z.number(),
                    actual: z.array(z.unknown()),
                    methods: z.array(z.unknown()),
                    planned: z.array(z.unknown()),
                    diagnostics: z.unknown().nullable(),
                    history_months: z.number(),
                    include_planned: z.boolean(),
                }),
            ),
        ],
        [
            "GET /api/aggregations/cashflow-forecast-rolling returns expected shape",
            "/api/aggregations/cashflow-forecast-rolling",
            "GET /api/aggregations/cashflow-forecast-rolling",
            aggregationsEnvelope(
                z.object({
                    window_start: z.string(),
                    window_end: z.string(),
                    today: z.string(),
                    currency: z.string(),
                    days_back: z.number(),
                    days_forward: z.number(),
                    actual: z.array(z.unknown()),
                    methods: z.array(z.unknown()),
                    planned: z.array(z.unknown()),
                    diagnostics: z.unknown().nullable(),
                    history_months: z.number(),
                    include_planned: z.boolean(),
                }),
            ),
        ],
        [
            "GET /api/aggregations/category-pivot returns expected shape",
            "/api/aggregations/category-pivot",
            "GET /api/aggregations/category-pivot",
            aggregationsEnvelope(
                z.object({ categoryPivot: z.record(z.string(), z.unknown()) }),
            ),
        ],
        [
            "GET /api/aggregations/recipient-by-year returns expected shape",
            "/api/aggregations/recipient-by-year",
            "GET /api/aggregations/recipient-by-year",
            aggregationsEnvelope(
                z.object({
                    recipientsByYear: z.record(z.string(), z.unknown()),
                }),
            ),
        ],
        [
            "GET /api/aggregations/recipient-pivot returns expected shape",
            "/api/aggregations/recipient-pivot",
            "GET /api/aggregations/recipient-pivot",
            aggregationsEnvelope(
                z.object({ recipientPivot: z.record(z.string(), z.unknown()) }),
            ),
        ],
        [
            "GET /api/aggregations/sankey returns expected shape",
            "/api/aggregations/sankey",
            "GET /api/aggregations/sankey",
            aggregationsEnvelope(
                z.object({
                    nodes: z.array(z.unknown()),
                    links: z.array(z.unknown()),
                    year: z.number(),
                }),
            ),
        ],
        [
            "GET /api/aggregations/category-breakdown returns expected shape",
            "/api/aggregations/category-breakdown",
            "GET /api/aggregations/category-breakdown",
            aggregationsEnvelope(
                z.object({ categories: z.array(z.unknown()) }),
            ),
        ],
        [
            "GET /api/aggregations/bank-balances returns expected shape",
            "/api/aggregations/bank-balances",
            "GET /api/aggregations/bank-balances",
            aggregationsEnvelope(
                z.object({
                    accounts: z.array(z.unknown()),
                    total_net_position: z.number(),
                    history: z.record(z.string(), z.array(z.unknown())),
                    total_history: z.array(z.unknown()),
                }),
            ),
        ],
        [
            "GET /api/aggregations/average-vs-current returns expected shape",
            "/api/aggregations/average-vs-current",
            "GET /api/aggregations/average-vs-current",
            aggregationsEnvelope(z.object({ months: z.array(z.unknown()) })),
        ],
        [
            "GET /api/ai/conversations/:id returns conversation + messages",
            "/api/ai/conversations/conv-1",
            "GET /api/ai/conversations/:id",
            z.object({
                conversation: z.object({
                    id: z.string(),
                    title: z.string(),
                    model: z.string(),
                    createdAt: z.string(),
                    updatedAt: z.string(),
                }),
                messages: z.array(z.unknown()),
            }),
        ],
        [
            "GET /api/ai/models returns { items, total }",
            "/api/ai/models",
            "GET /api/ai/models",
            collectionSchema(),
        ],
        [
            "GET /api/attachments/transaction/:id returns items array",
            "/api/attachments/transaction/1",
            "GET /api/attachments/transaction/:id",
            z.object({ items: z.array(z.unknown()) }),
        ],
        [
            "GET /api/categories/:id returns single category",
            "/api/categories/1",
            "GET /api/categories/:id",
            CategoryItemSchema,
        ],
        [
            "GET /api/info/portfolio-summary returns totals shape",
            "/api/info/portfolio-summary",
            "GET /api/info/portfolio-summary",
            PortfolioSummarySchema.partial({ computed_at: true }),
        ],
        [
            "GET /api/investments/providers returns providers shape",
            "/api/investments/providers",
            "GET /api/investments/providers",
            z.object({ providers: z.array(z.unknown()) }),
        ],
        [
            "GET /api/investments/transactions returns paginated shape",
            "/api/investments/transactions",
            "GET /api/investments/transactions",
            z.object({
                items: z.array(z.unknown()),
                total: z.number().int().nonnegative(),
                limit: z.number().int().positive(),
                offset: z.number().int().nonnegative(),
                links: z.array(LinkSchema),
            }),
        ],
        [
            "GET /api/investments/:id/transactions returns items+total",
            "/api/investments/1/transactions",
            "GET /api/investments/:id/transactions",
            z.object({ items: z.array(z.unknown()), total: z.number() }),
        ],
        [
            "GET /api/recipients/clusters returns clusters array",
            "/api/recipients/clusters",
            "GET /api/recipients/clusters",
            z.object({ clusters: z.array(z.unknown()) }),
        ],
        [
            "GET /api/recipients/:id/aliases returns aliases array",
            "/api/recipients/1/aliases",
            "GET /api/recipients/:id/aliases",
            z.object({ aliases: z.array(z.unknown()) }),
        ],
        [
            "GET /api/recipients/:id/patterns returns paginated patterns",
            "/api/recipients/1/patterns",
            "GET /api/recipients/:id/patterns",
            z.object({ items: z.array(z.unknown()), total: z.number() }),
        ],
        [
            "GET /api/saved-charts returns { items, total }",
            "/api/saved-charts",
            "GET /api/saved-charts",
            collectionSchema(),
        ],
        [
            "GET /api/splits/transaction/:id returns items array",
            "/api/splits/transaction/1",
            "GET /api/splits/transaction/:id",
            z.object({ items: z.array(z.unknown()) }),
        ],
        [
            "GET /api/splits/owed/:recipientId returns items + total",
            "/api/splits/owed/1",
            "GET /api/splits/owed/:recipientId",
            z.object({ items: z.array(z.unknown()), total: z.number() }),
        ],
        [
            "GET /api/transactions/:id returns single transaction",
            "/api/transactions/1",
            "GET /api/transactions/:id",
            TransactionItemSchema,
        ],
        [
            "GET /api/planned-transactions/due-soon returns { items, total, days }",
            "/api/planned-transactions/due-soon",
            "GET /api/planned-transactions/due-soon",
            collectionSchema().extend({ days: z.number().int().positive() }),
        ],
    ])("%s", async (_name, path, label, schema) => {
        validate(schema, await getEnvelope(path), label);
    });
});

describe("Phase F1: extended mutation contracts", () => {
    const MessageSchema = z.object({ message: z.string() });
    const ConversationSchema = z.object({
        id: z.string(),
        title: z.string(),
        model: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
    });
    // POST /api/ai/conversations and GET /api/ai/conversations/:id share this
    // shape. The POST route names its local `conversation` (routes/ai.js:272)
    // but assigns it `createEmptyConversation`'s return value, which really is
    // `{ conversation, messages: [] }` (services/aiChatService.js:468-475) —
    // verified in the service, not inferred from the variable name.
    const ConversationWithMessagesSchema = z.object({
        conversation: ConversationSchema,
        messages: z.array(z.unknown()),
    });

    // routes/ai.js:324-331 — the non-streaming chat turn. `usage` is
    // aiChatService's `lastUsage` (every counter nullable until the model
    // answers); `ChatTurnResponse` in types/aiChat.ts is the client-side twin.
    const ChatMessageSchema = z.object({
        id: z.string(),
        conversationId: z.string(),
        role: z.string(),
        content: z.string().nullable(),
        createdAt: z.string(),
    });
    const ChatTurnSchema = z.object({
        conversation: ConversationSchema,
        userMessage: ChatMessageSchema,
        toolMessages: z.array(ChatMessageSchema),
        assistantMessage: ChatMessageSchema,
        usage: z.object({
            evalCount: z.number().nullable(),
            promptEvalCount: z.number().nullable(),
            totalDurationMs: z.number().nullable(),
        }),
        iterations: z.number().int().nonnegative(),
    });

    // `splitRepository.formatSplit` (splitRepository.js:717) — the body of
    // POST /api/splits/:id/settle.
    const SplitSchema = z.object({
        id: z.number().int().positive(),
        transaction_id: z.number().int().positive(),
        recipient_id: z.number().int().positive(),
        recipient_name: z.string().nullable(),
        amount: z.number(),
        amount_paid: z.number(),
        note: z.string().nullable(),
        is_settled: z.boolean(),
        created_at: z.string(),
        updated_at: z.string(),
    });

    // `splitRepository.formatPayment` (splitRepository.js:701) — the body of
    // POST /api/splits/:id/pay.
    const SplitPaymentSchema = z.object({
        id: z.number().int().positive(),
        split_id: z.number().int().positive(),
        amount: z.number(),
        note: z.string().nullable(),
        paid_at: z.string(),
        created_at: z.string(),
    });

    // The counter object both CSV metadata importers answer with:
    // `res.ok({ ...result, status })`, routes/importRoutes.js:388 / :406.
    const CsvCountsSchema = z.object({
        total_processed: z.number().int().nonnegative(),
        imported: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        status: z.enum(["completed", "completed_with_errors"]),
    });

    // accountRepository's COLUMNS (accountRepository.js:26-29) plus the route's
    // `links: []`. Every accounts single-row body carries exactly these —
    // `.strict()` because the drift this row exists to catch is ADDITIVE: the
    // list endpoint's enrichments (`computed_balance`, `drift`,
    // `reconcilable_*`, anchor provenance — "list endpoint only" on the
    // Account type) leaking into a single-row fixture would sail through a
    // key-stripping schema, exactly as ACCOUNT_STUB's stowaway
    // `computed_balance`/`drift` once did.
    const AccountSchema = z.strictObject({
        id: z.number().int().positive(),
        name: z.string(),
        display_name: z.string().nullable(),
        institution: z.string().nullable(),
        currency: z.string(),
        type: z.string(),
        liquidity_class: z.string(),
        spendable: z.boolean(),
        in_net_worth: z.boolean(),
        tax_wrapper: z.string(),
        owner: z.string(),
        multi_currency_cash: z.boolean(),
        has_cash_sleeve: z.boolean(),
        funding_account_id: z.number().int().positive().nullable(),
        statement_balance: z.number().nullable(),
        statement_balance_date: z.string().nullable(),
        is_active: z.boolean(),
        closed_at: z.string().nullable(),
        created_at: z.string(),
        updated_at: z.string().nullable(),
        links: z.array(z.unknown()),
    });

    // `attachmentRepository.formatRow` (attachmentRepository.js:19-29). Note
    // `size_bytes` (number), not `size` — AttachmentPanel.tsx:61 reads it.
    const AttachmentSchema = z.object({
        id: z.number().int().positive(),
        transaction_id: z.number().int().positive(),
        filename: z.string(),
        stored_path: z.string(),
        mime_type: z.string(),
        size_bytes: z.number(),
        created_at: z.string(),
    });

    // Both CSV import routes answer with the same object on the auto-commit
    // path — `buildImportResult(buildPipelineResult(...))`, node-backend
    // routes/importRoutes.js:59-94. `status` is derived server-side from
    // `errors`, so the vocabulary is closed.
    const ImportCsvResultSchema = z.object({
        total: z.number().int().nonnegative(),
        imported: z.number().int().nonnegative(),
        duplicates: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        batch_id: z.number().int().positive(),
        auto_linked_count: z.number().int().nonnegative(),
        status: z.enum(["completed", "completed_with_errors"]),
        error_message: z.string().nullable(),
        links: z.array(LinkSchema),
    });

    // Last column = the exact status the real express route answers, read off
    // its `res.status(...)` call (or its absence → 200). Cited per row so a
    // future reader can re-derive it without trusting the mock.
    it.each<
        [
            string,
            "POST" | "PATCH" | "PUT",
            string,
            Record<string, unknown> | undefined,
            string,
            z.ZodTypeAny,
            number,
        ]
    >([
        [
            // `res.ok({ vacuumed: table ?? 'all' })` — there is no `message`.
            "POST /api/admin/database/vacuum returns { vacuumed }",
            "POST",
            "/api/admin/database/vacuum",
            undefined,
            "POST /api/admin/database/vacuum",
            z.object({ vacuumed: z.string() }),
            200, // routes/admin.js:282 — bare res.ok
        ],
        [
            // The non-streaming turn returns the WHOLE turn, not one message.
            "POST /api/ai/chat returns the chat turn",
            "POST",
            "/api/ai/chat",
            { conversationId: "conv-1", content: "test" },
            "POST /api/ai/chat",
            ChatTurnSchema,
            200, // routes/ai.js:324-331 — bare res.ok
        ],
        [
            "POST /api/ai/conversations returns conversation+messages",
            "POST",
            "/api/ai/conversations",
            { title: "Test" },
            "POST /api/ai/conversations",
            ConversationWithMessagesSchema,
            201, // routes/ai.js:273
        ],
        [
            // Message only — the route counts nothing, so there is no
            // `rates_updated` field to read.
            "POST /api/info/exchange-rates/refresh returns message only",
            "POST",
            "/api/info/exchange-rates/refresh",
            undefined,
            "POST /api/info/exchange-rates/refresh",
            MessageSchema,
            200, // routes/info/rates.js:94 — bare res.ok
        ],
        [
            "POST /api/info/refresh-views returns message",
            "POST",
            "/api/info/refresh-views",
            undefined,
            "POST /api/info/refresh-views",
            MessageSchema,
            200, // routes/info/maintenance.js:20 — bare res.ok
        ],
        [
            // `res.ok(settingsRepository.set(...))` — the stored `{ key, value }`
            // row (settingsRepository.js:98), NOT an `{ok: true}` sentinel; the
            // client types it `Promise<{ key, value }>` (lib/api/settings.ts:11).
            "PUT /api/settings/:key returns the stored setting",
            "PUT",
            "/api/settings/language",
            { value: "en" },
            "PUT /api/settings/:key",
            z.object({ key: z.string(), value: z.unknown() }),
            200, // routes/settings.js:328 — bare res.ok
        ],
        [
            "POST /api/investments/refresh-prices returns price refresh shape",
            "POST",
            "/api/investments/refresh-prices",
            undefined,
            "POST /api/investments/refresh-prices",
            z.object({
                message: z.string(),
                updated_count: z.number(),
                stale_count: z.number(),
                cached_count: z.number(),
                live: z.boolean(),
            }),
            200, // controllers/investmentController.js:440 — bare res.ok
        ],
        [
            "POST /api/investments/:id/transactions returns single transaction",
            "POST",
            "/api/investments/1/transactions",
            {},
            "POST /api/investments/:id/transactions",
            z.object({
                id: z.number(),
                investment_id: z.number(),
                type: z.string(),
                amount: z.number(),
                currency: z.string(),
            }),
            201, // controllers/investmentController.js:612
        ],
        [
            "PATCH /api/investments/transactions/:id returns single transaction",
            "PATCH",
            "/api/investments/transactions/1",
            {},
            "PATCH /api/investments/transactions/:id",
            z.object({
                id: z.number(),
                investment_id: z.number(),
                type: z.string(),
            }),
            200, // controllers/investmentController.js:682 — bare res.ok
        ],
        [
            // `{ primary, merged_ids, reassigned, aliases, patternSuggestion }`
            // — routes/recipients.js:157-163. `primary` is the re-read
            // recipient row, `reassigned` the merge service's repoint counters
            // (recipientMergeService.js:94-100), `patternSuggestion` the
            // optional `{ pattern, kind, matchCount, confidence }` rule hint.
            // The success toast reads `merged_ids.length` and `primary.name`
            // (useRecipients.ts:91), so the old `{message, merged_count}`
            // fixture meant no test could exercise that path against the
            // default handler.
            "POST /api/recipients/:id/merge returns the merge summary",
            "POST",
            "/api/recipients/1/merge",
            { alias_ids: [2] },
            "POST /api/recipients/:id/merge",
            z.object({
                primary: RecipientItemSchema,
                merged_ids: z.array(z.number().int().positive()),
                reassigned: z.object({
                    transactions: z.number().int().nonnegative(),
                    splits: z.number().int().nonnegative(),
                    planned: z.number().int().nonnegative(),
                    bankAccounts: z.number().int().nonnegative(),
                }),
                aliases: z.array(
                    z.object({
                        id: z.number().int().positive(),
                        name: z.string(),
                    }),
                ),
                patternSuggestion: z
                    .object({
                        pattern: z.string(),
                        kind: z.enum(["literal_prefix", "glob", "regex"]),
                        matchCount: z.number().int().nonnegative(),
                        confidence: z.enum(["high", "medium", "low"]),
                    })
                    .nullable(),
            }),
            200, // routes/recipients.js:157 — bare res.ok
        ],
        [
            // Returns the re-read recipient (`{ ...recipient, links: [] }`),
            // not an acknowledgement.
            "POST /api/recipients/:id/unmerge returns the recipient",
            "POST",
            "/api/recipients/1/unmerge",
            undefined,
            "POST /api/recipients/:id/unmerge",
            RecipientItemSchema,
            200, // routes/recipients.js:172 — bare res.ok
        ],
        [
            "POST /api/recipients/:id/patterns returns pattern shape",
            "POST",
            "/api/recipients/1/patterns",
            {},
            "POST /api/recipients/:id/patterns",
            z.object({
                id: z.number(),
                pattern: z.string(),
                pattern_kind: z.string(),
                case_sensitive: z.boolean(),
                priority: z.number(),
                is_active: z.boolean(),
                source: z.string(),
            }),
            201, // routes/recipients.js:201
        ],
        [
            "POST /api/recipients/:id/patterns/preview returns matches",
            "POST",
            "/api/recipients/1/patterns/preview",
            {},
            "POST /api/recipients/:id/patterns/preview",
            z.object({ matches: z.array(z.unknown()) }),
            200, // routes/recipients.js:209 — bare res.ok (preview creates nothing)
        ],
        [
            "POST /api/saved-charts returns chart shape",
            "POST",
            "/api/saved-charts",
            {},
            "POST /api/saved-charts",
            z.object({
                id: z.number(),
                name: z.string(),
                config: z.unknown(),
                created_at: z.string(),
            }),
            201, // routes/savedCharts.js:175
        ],
        [
            "PATCH /api/saved-charts/:id returns chart shape",
            "PATCH",
            "/api/saved-charts/1",
            {},
            "PATCH /api/saved-charts/:id",
            z.object({ id: z.number(), name: z.string() }),
            200, // routes/savedCharts.js:186 — bare res.ok
        ],
        [
            "POST /api/splits/batch returns items",
            "POST",
            "/api/splits/batch",
            {},
            "POST /api/splits/batch",
            z.object({ items: z.array(z.unknown()) }),
            201, // routes/splits.js:298
        ],
        // NOTE: there is deliberately no `PATCH /api/splits/:id` row here.
        // routes/splits.js registers get/post/delete only, so that verb 404s
        // in production; the row and its handler were removed rather than
        // rewritten, and no frontend client sends a PATCH there.
        [
            // Answers with the inserted split_payments row, not a message.
            "POST /api/splits/:id/pay returns the payment row",
            "POST",
            "/api/splits/1/pay",
            {},
            "POST /api/splits/:id/pay",
            SplitPaymentSchema,
            201, // routes/splits.js:320 — inserts a payment row
        ],
        [
            // Answers with the updated split row, not a message.
            "POST /api/splits/:id/settle returns the split row",
            "POST",
            "/api/splits/1/settle",
            {},
            "POST /api/splits/:id/settle",
            SplitSchema,
            200, // routes/splits.js:343 — bare res.ok (flips a flag)
        ],
        [
            "POST /api/splits/owed/:recipientId/settle-all returns settled count",
            "POST",
            "/api/splits/owed/1/settle-all",
            {},
            "POST /api/splits/owed/:recipientId/settle-all",
            z.object({ message: z.string(), settled_count: z.number() }),
            200, // routes/splits.js:357 — bare res.ok
        ],
        [
            "POST /api/watchlist returns watchlist item",
            "POST",
            "/api/watchlist",
            {},
            "POST /api/watchlist",
            z.object({
                id: z.number(),
                symbol: z.string(),
                name: z.string(),
                asset_class: z.string(),
                target_price: z.number(),
            }),
            201, // routes/watchlist.js:196
        ],
        [
            "PATCH /api/watchlist/:id returns watchlist item",
            "PATCH",
            "/api/watchlist/1",
            {},
            "PATCH /api/watchlist/:id",
            z.object({ id: z.number(), symbol: z.string() }),
            200, // routes/watchlist.js:205 — bare res.ok
        ],
        [
            "POST /api/planned-transactions/:id/execute returns updated planned",
            "POST",
            "/api/planned-transactions/1/execute",
            {},
            "POST /api/planned-transactions/:id/execute",
            PlannedTransactionItemSchema,
            200, // routes/plannedTransactions.js:566 — bare res.ok
        ],
        [
            "POST /api/import/csv returns completed import result",
            "POST",
            "/api/import/csv",
            {},
            "POST /api/import/csv",
            ImportCsvResultSchema,
            201, // routes/importRoutes.js:242 (auto-commit arm; review arm = 202 below)
        ],
        [
            "POST /api/import/csv/custom returns completed import result",
            "POST",
            "/api/import/csv/custom",
            {},
            "POST /api/import/csv/custom",
            ImportCsvResultSchema,
            201, // routes/importRoutes.js:283 (auto-commit arm; review arm = 202 below)
        ],
        [
            "POST /api/import/batches/:batchId/commit returns commit result",
            "POST",
            "/api/import/batches/1/commit",
            {},
            "POST /api/import/batches/:batchId/commit",
            z.object({
                message: z.string(),
                batch_id: z.number(),
                transactions_committed: z.number(),
            }),
            200, // routes/importRoutes.js:621 — bare res.ok
        ],
        [
            // POST, not PUT: routes/importRoutes.js:549, and
            // `lib/api/imports.ts::overrideImportRow` posts. The body echoes
            // the row id and the override that landed — never a message.
            "POST /api/import/batches/:batchId/rows/:rowId/override returns the applied override",
            "POST",
            "/api/import/batches/1/rows/1/override",
            {},
            "POST override",
            z.object({
                row_id: z.number().int().positive(),
                user_override_recipient_id: z
                    .number()
                    .int()
                    .positive()
                    .nullable(),
            }),
            200, // routes/importRoutes.js:568 — bare res.ok
        ],

        // ── Rows added for the four handlers ea3a2eb corrected to 201 but
        // left uncovered by this table. Statuses cited as above; bodies read
        // off the same routes.
        [
            "POST /api/accounts returns the created account",
            "POST",
            "/api/accounts",
            {},
            "POST /api/accounts",
            AccountSchema,
            201, // routes/accounts.js:55
        ],
        [
            "POST /api/attachments/transaction/:id returns the attachment row",
            "POST",
            "/api/attachments/transaction/1",
            {},
            "POST /api/attachments/transaction/:id",
            AttachmentSchema,
            201, // routes/attachments.js:112
        ],
        [
            "POST /api/import/categories returns CSV counts",
            "POST",
            "/api/import/categories",
            {},
            "POST /api/import/categories",
            CsvCountsSchema,
            201, // routes/importRoutes.js:406
        ],
        [
            // Same counter object plus `bank_account_errors`
            // (RecipientImportResults, dataImportService.js:69-75).
            "POST /api/import/recipients returns CSV counts",
            "POST",
            "/api/import/recipients",
            {},
            "POST /api/import/recipients",
            CsvCountsSchema.extend({
                bank_account_errors: z.number().int().nonnegative(),
            }),
            201, // routes/importRoutes.js:388
        ],
    ])("%s", async (_name, method, path, body, label, schema, status) => {
        validate(
            schema,
            await mutateEnvelope(method, path, body, status),
            label,
        );
    });

    // The other arm of the same two routes. Both import routes answer 202 with
    // `respondReviewRequired`'s object (importRoutes.js:74-84) when rows still
    // need review: no counts at all, because nothing was committed. Pinned here
    // so the client-side union (`ImportCsvResponse` in lib/api/imports.ts) has
    // a fixture on both arms rather than only the auto-commit one.
    const ImportCsvReviewRequiredSchema = z.object({
        batch_id: z.number().int().positive(),
        requires_review: z.literal(true),
        match_source_counts: z.record(
            z.string(),
            z.number().int().nonnegative(),
        ),
    });

    it.each([
        ["POST /api/import/csv", "/api/import/csv"],
        ["POST /api/import/csv/custom", "/api/import/csv/custom"],
    ])("%s answers 202 with the review-required shape", async (label, path) => {
        server.use(...importCsvReviewRequiredHandlers);

        const res = await fetch(`${BASE}${path}`, { method: "POST" });
        expect(res.status, `expected 202 for POST ${path}`).toBe(202);

        const json = (await res.json()) as { ok: boolean; data: unknown };
        expect(json.ok).toBe(true);
        const data = validate(ImportCsvReviewRequiredSchema, json.data, label);

        // The counts the 201 arm carries must be absent here — reading them is
        // exactly the drift this fixture exists to catch.
        expect(data).not.toHaveProperty("total");
        expect(data).not.toHaveProperty("imported");
        expect(data).not.toHaveProperty("total_processed");
    });
});
