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
    TRANSACTION_STUB,
    CATEGORY_STUB,
    RECIPIENT_STUB,
    INVESTMENT_STUB,
    PLANNED_TRANSACTION_STUB,
} from "./handlers";

const BASE = "http://localhost:3002";

// ── Test helpers ──────────────────────────────────────────────────────────────

async function getEnvelope(path: string): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`);
    expect(res.ok, `HTTP ${res.status} for ${path}`).toBe(true);
    const json = (await res.json()) as { ok: boolean; data: unknown };
    expect(json.ok, `envelope.ok false for ${path}`).toBe(true);
    return json.data;
}

async function mutateEnvelope(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    expect(res.ok, `HTTP ${res.status} for ${method} ${path}`).toBe(true);
    const json = (await res.json()) as { ok: boolean; data: unknown };
    expect(json.ok, `envelope.ok false for ${method} ${path}`).toBe(true);
    return json.data;
}

function validate<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
    const result = schema.safeParse(data);
    if (!result.success) {
        throw new Error(`Contract violation [${label}]:\n${result.error.toString()}`);
    }
    return result.data;
}

// ── Shared schema fragments ───────────────────────────────────────────────────

const LinkSchema = z.object({ rel: z.string(), href: z.string() });

const paginatedOf = <T extends z.ZodTypeAny>(item: T) =>
    z.object({
        items: z.array(item),
        total: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
        offset: z.number().int().nonnegative(),
        links: z.array(LinkSchema),
    });

// ── ADR-026 error envelope ────────────────────────────────────────────────────

const ErrorEnvelopeSchema = z.object({
    ok: z.literal(false),
    error: z.object({
        message: z.string(),
        code: z.string().optional(),
    }),
});

// ── Strict resource item schemas (E1) ─────────────────────────────────────────

const CategoryItemSchema = z.object({
    id: z.number().int().positive(),
    general: z.string(),
    detail: z.string().nullable(),
    description: z.string().nullable(),
    is_active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
    category_name: z.string(),
    links: z.array(z.unknown()),
});

const RecipientItemSchema = z.object({
    id: z.number().int().positive(),
    name: z.string(),
    normalized_name: z.string(),
    default_category_id: z.number().int().positive().nullable(),
    primary_recipient_id: z.number().int().positive().nullable(),
    notes: z.string().nullable(),
    is_active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
    links: z.array(z.unknown()),
});

const TransactionItemSchema = z.object({
    id: z.number().int().positive(),
    transaction_date: z.string(),
    date: z.string(),
    bank_account: z.string(),
    recipient_id: z.number().int().positive().nullable(),
    recipient_name: z.string().nullable(),
    memo: z.string().nullable(),
    amount: z.number(),
    currency: z.string(),
    balance: z.number().nullable(),
    category_id: z.number().int().positive().nullable(),
    category_name: z.string().nullable(),
    comment: z.string().nullable(),
    is_active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
});

const InvestmentItemSchema = z.object({
    id: z.number().int().positive(),
    name: z.string(),
    symbol: z.string(),
    asset_class: z.string(),
    currency: z.string(),
    current_price: z.number().nullable(),
    interest_rate: z.number().nullable(),
    maturity_date: z.string().nullable(),
    location: z.string().nullable(),
    municipality: z.string().nullable(),
    cadastral_income: z.number().nullable(),
    municipality_tax_rate: z.number().nullable(),
    notes: z.string().nullable(),
    is_active: z.boolean(),
    price_provider: z.string().nullable(),
    price_provider_id: z.string().nullable(),
    price_provider_url: z.string().nullable(),
    price_provider_latest_url: z.string().nullable(),
    price_provider_latest_path: z.string().nullable(),
    price_provider_history_url: z.string().nullable(),
    price_provider_history_path: z.string().nullable(),
    price_provider_history_ts_path: z.string().nullable(),
    price_provider_history_price_path: z.string().nullable(),
    price_updated_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
});

const PlannedTransactionItemSchema = z.object({
    id: z.number().int().positive(),
    planned_date: z.string(),
    bank_account: z.string().nullable(),
    recipient_id: z.number().int().positive().nullable(),
    recipient_name: z.string().nullable(),
    memo: z.string().nullable(),
    amount: z.number(),
    currency: z.string(),
    category_id: z.number().int().positive().nullable(),
    category_name: z.string().nullable(),
    comment: z.string().nullable(),
    url: z.string().nullable(),
    is_recurring: z.boolean(),
    recurrence_pattern: z.string().nullable(),
    reminder_days_before: z.number().int().nullable(),
    is_executed: z.boolean(),
    last_executed_date: z.string().nullable(),
    is_loan: z.boolean(),
    loan_type: z.string().nullable(),
    loan_principal: z.number().nullable(),
    loan_annual_interest_rate: z.number().nullable(),
    loan_term_months: z.number().int().nullable(),
    loan_start_date: z.string().nullable(),
    loan_payment_day: z.number().int().nullable(),
    loan_regular_payment_amount: z.number().nullable(),
    loan_first_payment_date: z.string().nullable(),
    loan_schedule: z.array(z.unknown()),
    executed_transaction_id: z.number().int().positive().nullable(),
    execution_count: z.number().int().nonnegative(),
    executions: z.array(z.unknown()),
    is_active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
    links: z.array(z.unknown()),
});

// ── Delete response schemas ───────────────────────────────────────────────────

const DeleteResponseSchema = z.object({
    message: z.string(),
    links: z.array(z.unknown()),
});

const TransactionDeleteResponseSchema = DeleteResponseSchema.extend({
    details: z.object({ method: z.string() }).optional(),
});

// ── Other endpoint schemas ────────────────────────────────────────────────────

const SettingsSchema = z.record(z.unknown());
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
    fallback_rates: z.record(z.unknown()),
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
const MarketNewsSchema = z.object({ articles: z.array(NewsArticleSchema) });

const ImportBatchesSchema = z.object({
    batches: z.array(z.object({}).passthrough()),
    total: z.number().int().nonnegative(),
});

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
    it("GET /api/settings conforms to settings schema", async () => {
        validate(SettingsSchema, await getEnvelope("/api/settings"), "settings");
    });

    it("GET /api/settings/:key conforms to nullable value schema", async () => {
        validate(SettingValueSchema, await getEnvelope("/api/settings/language"), "settings/:key");
    });

    it("GET /api/info conforms to app-info schema", async () => {
        validate(InfoSchema, await getEnvelope("/api/info"), "info");
    });

    it("GET /api/info/health conforms to health schema", async () => {
        validate(HealthSchema, await getEnvelope("/api/info/health"), "health");
    });

    it("GET /api/aggregations/:name accepts nullable blob", async () => {
        validate(z.unknown(), await getEnvelope("/api/aggregations/monthly"), "aggregations/:name");
    });

    it("GET /api/info/exchange-rates conforms to rates schema", async () => {
        validate(ExchangeRatesSchema, await getEnvelope("/api/info/exchange-rates"), "exchange-rates");
    });

    it("GET /api/market/news conforms to news schema", async () => {
        validate(MarketNewsSchema, await getEnvelope("/api/market/news"), "market/news");
    });

    it("GET /api/import/batches conforms to batches schema", async () => {
        validate(ImportBatchesSchema, await getEnvelope("/api/import/batches"), "import/batches");
    });

    it("GET /api/portfolio/summary conforms to portfolio-summary schema", async () => {
        validate(PortfolioSummarySchema, await getEnvelope("/api/portfolio/summary"), "portfolio/summary");
    });

    it("GET /api/admin/endpoint-liveness conforms to array schema", async () => {
        validate(z.array(z.unknown()), await getEnvelope("/api/admin/endpoint-liveness"), "admin/endpoint-liveness");
    });

    it("GET /api/planned conforms to array schema", async () => {
        validate(z.array(z.unknown()), await getEnvelope("/api/planned"), "planned");
    });
});

// ── E1: Strict list item schemas ──────────────────────────────────────────────

describe("GET list endpoints — strict item schemas (E1)", () => {
    describe("/api/categories", () => {
        it("empty list envelope is valid", async () => {
            validate(paginatedOf(CategoryItemSchema), await getEnvelope("/api/categories"), "categories empty");
        });

        it("item shape matches CategoryItemSchema", async () => {
            server.use(
                http.get(`${BASE}/api/categories`, () =>
                    HttpResponse.json({
                        ok: true,
                        data: { items: [CATEGORY_STUB], total: 1, limit: 200, offset: 0, links: [] },
                    }),
                ),
            );
            const data = await getEnvelope("/api/categories");
            const parsed = validate(paginatedOf(CategoryItemSchema), data, "categories item");
            expect(parsed.items).toHaveLength(1);
        });
    });

    describe("/api/recipients", () => {
        it("empty list envelope is valid", async () => {
            validate(paginatedOf(RecipientItemSchema), await getEnvelope("/api/recipients"), "recipients empty");
        });

        it("item shape matches RecipientItemSchema", async () => {
            server.use(
                http.get(`${BASE}/api/recipients`, () =>
                    HttpResponse.json({
                        ok: true,
                        data: { items: [RECIPIENT_STUB], total: 1, limit: 200, offset: 0, links: [] },
                    }),
                ),
            );
            const data = await getEnvelope("/api/recipients");
            const parsed = validate(paginatedOf(RecipientItemSchema), data, "recipients item");
            expect(parsed.items).toHaveLength(1);
        });
    });

    describe("/api/transactions", () => {
        it("empty list envelope is valid", async () => {
            validate(paginatedOf(TransactionItemSchema), await getEnvelope("/api/transactions"), "transactions empty");
        });

        it("item shape matches TransactionItemSchema", async () => {
            server.use(
                http.get(`${BASE}/api/transactions`, () =>
                    HttpResponse.json({
                        ok: true,
                        data: { items: [TRANSACTION_STUB], total: 1, limit: 50, offset: 0, links: [] },
                    }),
                ),
            );
            const data = await getEnvelope("/api/transactions");
            const parsed = validate(paginatedOf(TransactionItemSchema), data, "transactions item");
            expect(parsed.items).toHaveLength(1);
        });
    });

    describe("/api/planned-transactions", () => {
        it("empty list envelope is valid", async () => {
            validate(
                paginatedOf(PlannedTransactionItemSchema),
                await getEnvelope("/api/planned-transactions"),
                "planned-transactions empty",
            );
        });

        it("item shape matches PlannedTransactionItemSchema", async () => {
            server.use(
                http.get(`${BASE}/api/planned-transactions`, () =>
                    HttpResponse.json({
                        ok: true,
                        data: { items: [PLANNED_TRANSACTION_STUB], total: 1, limit: 1000, offset: 0, links: [] },
                    }),
                ),
            );
            const data = await getEnvelope("/api/planned-transactions");
            const parsed = validate(
                paginatedOf(PlannedTransactionItemSchema),
                data,
                "planned-transactions item",
            );
            expect(parsed.items).toHaveLength(1);
        });
    });

    describe("/api/investments", () => {
        it("empty list envelope is valid", async () => {
            validate(paginatedOf(InvestmentItemSchema), await getEnvelope("/api/investments"), "investments empty");
        });

        it("item shape matches InvestmentItemSchema", async () => {
            server.use(
                http.get(`${BASE}/api/investments`, () =>
                    HttpResponse.json({
                        ok: true,
                        data: { items: [INVESTMENT_STUB], total: 1, limit: 100, offset: 0, links: [] },
                    }),
                ),
            );
            const data = await getEnvelope("/api/investments");
            const parsed = validate(paginatedOf(InvestmentItemSchema), data, "investments item");
            expect(parsed.items).toHaveLength(1);
        });
    });
});

// ── E2: Mutation contract tests ───────────────────────────────────────────────

describe("Mutation handler contracts (E2)", () => {
    describe("transactions", () => {
        it("POST /api/transactions response matches TransactionItemSchema", async () => {
            validate(TransactionItemSchema, await mutateEnvelope("POST", "/api/transactions", {}), "POST transactions");
        });

        it("PATCH /api/transactions/:id response matches TransactionItemSchema", async () => {
            validate(TransactionItemSchema, await mutateEnvelope("PATCH", "/api/transactions/1", {}), "PATCH transactions");
        });

        it("DELETE /api/transactions/:id response matches delete response schema", async () => {
            validate(TransactionDeleteResponseSchema, await mutateEnvelope("DELETE", "/api/transactions/1"), "DELETE transactions");
        });
    });

    describe("categories", () => {
        it("POST /api/categories response matches CategoryItemSchema", async () => {
            validate(CategoryItemSchema, await mutateEnvelope("POST", "/api/categories", {}), "POST categories");
        });

        it("PATCH /api/categories/:id response matches CategoryItemSchema", async () => {
            validate(CategoryItemSchema, await mutateEnvelope("PATCH", "/api/categories/1", {}), "PATCH categories");
        });

        it("DELETE /api/categories/:id response matches delete response schema", async () => {
            validate(DeleteResponseSchema, await mutateEnvelope("DELETE", "/api/categories/1"), "DELETE categories");
        });
    });

    describe("recipients", () => {
        it("POST /api/recipients response matches RecipientItemSchema", async () => {
            validate(RecipientItemSchema, await mutateEnvelope("POST", "/api/recipients", {}), "POST recipients");
        });

        it("PATCH /api/recipients/:id response matches RecipientItemSchema", async () => {
            validate(RecipientItemSchema, await mutateEnvelope("PATCH", "/api/recipients/1", {}), "PATCH recipients");
        });

        it("DELETE /api/recipients/:id response matches delete response schema", async () => {
            validate(DeleteResponseSchema, await mutateEnvelope("DELETE", "/api/recipients/1"), "DELETE recipients");
        });
    });

    describe("investments", () => {
        it("POST /api/investments response matches InvestmentItemSchema", async () => {
            validate(InvestmentItemSchema, await mutateEnvelope("POST", "/api/investments", {}), "POST investments");
        });

        it("PATCH /api/investments/:id response matches InvestmentItemSchema", async () => {
            validate(InvestmentItemSchema, await mutateEnvelope("PATCH", "/api/investments/1", {}), "PATCH investments");
        });

        it("DELETE /api/investments/:id response matches delete response schema", async () => {
            validate(DeleteResponseSchema, await mutateEnvelope("DELETE", "/api/investments/1"), "DELETE investments");
        });
    });

    describe("planned-transactions", () => {
        it("POST /api/planned-transactions response matches PlannedTransactionItemSchema", async () => {
            validate(
                PlannedTransactionItemSchema,
                await mutateEnvelope("POST", "/api/planned-transactions", {}),
                "POST planned-transactions",
            );
        });

        it("PATCH /api/planned-transactions/:id response matches PlannedTransactionItemSchema", async () => {
            validate(
                PlannedTransactionItemSchema,
                await mutateEnvelope("PATCH", "/api/planned-transactions/1", {}),
                "PATCH planned-transactions",
            );
        });

        it("DELETE /api/planned-transactions/:id response matches delete response schema", async () => {
            validate(
                DeleteResponseSchema,
                await mutateEnvelope("DELETE", "/api/planned-transactions/1"),
                "DELETE planned-transactions",
            );
        });
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
        const json = await fetch(`${BASE}/api/categories`).then((r) => r.json());
        validate(ErrorEnvelopeSchema, json, "500 error envelope");
    });

    it("404 error response with optional code field conforms to schema", async () => {
        server.use(
            http.get(`${BASE}/api/transactions`, () =>
                HttpResponse.json(
                    { ok: false, error: { message: "Not found", code: "NOT_FOUND" } },
                    { status: 404 },
                ),
            ),
        );
        const json = await fetch(`${BASE}/api/transactions`).then((r) => r.json());
        validate(ErrorEnvelopeSchema, json, "404 error envelope with code");
    });

    it("422 mutation error response conforms to error envelope", async () => {
        server.use(
            http.post(`${BASE}/api/transactions`, () =>
                HttpResponse.json(
                    { ok: false, error: { message: "Validation failed", code: "VALIDATION_ERROR" } },
                    { status: 422 },
                ),
            ),
        );
        const json = await fetch(`${BASE}/api/transactions`, { method: "POST" }).then((r) => r.json());
        validate(ErrorEnvelopeSchema, json, "422 mutation error envelope");
    });

    it("503 error without code field still conforms to schema", async () => {
        server.use(
            http.get(`${BASE}/api/recipients`, () =>
                HttpResponse.json(
                    { ok: false, error: { message: "Database connection failed" } },
                    { status: 503 },
                ),
            ),
        );
        const json = await fetch(`${BASE}/api/recipients`).then((r) => r.json());
        validate(ErrorEnvelopeSchema, json, "503 error envelope without code");
    });
});

describe("Missing GET endpoint contracts (E4)", () => {
    it("GET /api/aggregations/monthly-summary returns expected shape", async () => {
        const data = await getEnvelope("/api/aggregations/monthly-summary");
        validate(
            z.object({
                data: z.object({
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
                meta: z.object({
                    computedAt: z.string(),
                    source: z.enum(["live", "cache"]),
                }),
            }),
            data,
            "GET /api/aggregations/monthly-summary",
        );
    });

    it("GET /api/aggregations/recipient-insights returns expected shape", async () => {
        const data = await getEnvelope("/api/aggregations/recipient-insights");
        validate(
            z.object({
                data: z.object({
                    topMerchants: z.array(z.unknown()),
                    monthOverMonth: z.array(z.unknown()),
                }),
                meta: z.object({
                    computedAt: z.string(),
                    source: z.enum(["live", "cache"]),
                }),
            }),
            data,
            "GET /api/aggregations/recipient-insights",
        );
    });

    it("GET /api/import/batches returns expected shape", async () => {
        const data = await getEnvelope("/api/import/batches");
        validate(
            z.object({ batches: z.array(z.unknown()), total: z.number() }),
            data,
            "GET /api/import/batches",
        );
    });

    it("GET /api/import/batches/:id/preview returns expected shape", async () => {
        const data = await getEnvelope("/api/import/batches/1/preview");
        validate(
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
            data,
            "GET /api/import/batches/:id/preview",
        );
    });

    it("GET /api/splits/owed returns expected shape", async () => {
        const data = await getEnvelope("/api/splits/owed");
        validate(z.object({ items: z.array(z.unknown()) }), data, "GET /api/splits/owed");
    });

    it("GET /api/market/quote returns expected shape", async () => {
        const data = await getEnvelope("/api/market/quote");
        validate(z.object({ quotes: z.array(z.unknown()) }), data, "GET /api/market/quote");
    });

    it("GET /api/market/search returns expected shape", async () => {
        const data = await getEnvelope("/api/market/search");
        validate(z.object({ results: z.array(z.unknown()) }), data, "GET /api/market/search");
    });

    it("GET /api/watchlist returns expected shape", async () => {
        const data = await getEnvelope("/api/watchlist");
        validate(
            z.object({
                items: z.array(z.unknown()),
                total: z.number(),
                limit: z.number(),
                offset: z.number(),
            }),
            data,
            "GET /api/watchlist",
        );
    });

    it("GET /api/ai/status returns expected shape", async () => {
        const data = await getEnvelope("/api/ai/status");
        validate(
            z.object({
                ok: z.boolean(),
                baseUrl: z.string(),
                defaultModel: z.string(),
                enabled: z.boolean(),
            }),
            data,
            "GET /api/ai/status",
        );
    });

    it("GET /api/ai/conversations returns array", async () => {
        const data = await getEnvelope("/api/ai/conversations");
        validate(z.array(z.unknown()), data, "GET /api/ai/conversations");
    });

    it("GET /api/info/portfolio-performance returns expected shape", async () => {
        const data = await getEnvelope("/api/info/portfolio-performance");
        validate(
            z.object({
                snapshots: z.array(z.unknown()),
                currency: z.string(),
                start_value: z.number(),
                end_value: z.number(),
                absolute_return: z.number(),
                percentage_return: z.number(),
            }),
            data,
            "GET /api/info/portfolio-performance",
        );
    });

    it("GET /api/info/net-worth returns expected shape", async () => {
        const data = await getEnvelope("/api/info/net-worth");
        validate(
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
            data,
            "GET /api/info/net-worth",
        );
    });

    it("GET /api/info/transaction-summary returns null when no data", async () => {
        const data = await getEnvelope("/api/info/transaction-summary");
        validate(z.null(), data, "GET /api/info/transaction-summary");
    });

    it("GET /api/info/transaction-count returns a number", async () => {
        const data = await getEnvelope("/api/info/transaction-count");
        validate(z.number(), data, "GET /api/info/transaction-count");
    });

    it("GET /api/info/recurring-patterns returns array", async () => {
        const data = await getEnvelope("/api/info/recurring-patterns");
        validate(z.array(z.unknown()), data, "GET /api/info/recurring-patterns");
    });

    it("GET /api/info/banks returns array", async () => {
        const data = await getEnvelope("/api/info/banks");
        validate(z.array(z.unknown()), data, "GET /api/info/banks");
    });

    it("GET /api/info/supported-adapters returns array", async () => {
        const data = await getEnvelope("/api/info/supported-adapters");
        validate(z.array(z.unknown()), data, "GET /api/info/supported-adapters");
    });

    it("GET /api/info/inflation-rates returns array", async () => {
        const data = await getEnvelope("/api/info/inflation-rates");
        validate(z.array(z.unknown()), data, "GET /api/info/inflation-rates");
    });

    it("GET /api/admin/endpoint-liveness returns array", async () => {
        const data = await getEnvelope("/api/admin/endpoint-liveness");
        validate(z.array(z.unknown()), data, "GET /api/admin/endpoint-liveness");
    });

    it("GET /api/admin/database/stats returns expected shape", async () => {
        const data = await getEnvelope("/api/admin/database/stats");
        validate(
            z.object({ tables: z.array(z.unknown()), db_size: z.null() }),
            data,
            "GET /api/admin/database/stats",
        );
    });

    it("GET /api/admin/providers/health returns array", async () => {
        const data = await getEnvelope("/api/admin/providers/health");
        validate(z.array(z.unknown()), data, "GET /api/admin/providers/health");
    });

    it("GET /api/admin/metrics/requests returns array", async () => {
        const data = await getEnvelope("/api/admin/metrics/requests");
        validate(z.array(z.unknown()), data, "GET /api/admin/metrics/requests");
    });

    it("GET /api/admin/endpoints returns array", async () => {
        const data = await getEnvelope("/api/admin/endpoints");
        validate(z.array(z.unknown()), data, "GET /api/admin/endpoints");
    });
});

// ── E5: Phase F1 — full contract surface coverage ────────────────────────────

const aggregationsEnvelope = (dataSchema: z.ZodTypeAny) =>
    z.object({
        data: dataSchema,
        meta: z.object({
            computedAt: z.string(),
            source: z.enum(["live", "cache"]),
        }),
    });

describe("Phase F1: extended GET endpoint contracts", () => {
    it("GET /api/admin/update/check returns update status", async () => {
        const data = await getEnvelope("/api/admin/update/check");
        validate(
            z.object({
                available: z.boolean(),
                current: z.string(),
                latest: z.string(),
            }),
            data,
            "GET /api/admin/update/check",
        );
    });

    it("GET /api/aggregations/cashflow-comparison returns expected shape", async () => {
        const data = await getEnvelope("/api/aggregations/cashflow-comparison");
        validate(
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
            data,
            "GET /api/aggregations/cashflow-comparison",
        );
    });

    it("GET /api/aggregations/cashflow-forecast-accuracy returns expected shape", async () => {
        const data = await getEnvelope("/api/aggregations/cashflow-forecast-accuracy");
        validate(
            aggregationsEnvelope(
                z.object({
                    methods: z.array(z.unknown()),
                    limit_months: z.number(),
                }),
            ),
            data,
            "GET /api/aggregations/cashflow-forecast-accuracy",
        );
    });

    it("GET /api/aggregations/cashflow-forecast-methods returns expected shape", async () => {
        const data = await getEnvelope("/api/aggregations/cashflow-forecast-methods");
        validate(
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
            data,
            "GET /api/aggregations/cashflow-forecast-methods",
        );
    });

    it("GET /api/aggregations/cashflow-forecast-rolling returns expected shape", async () => {
        const data = await getEnvelope("/api/aggregations/cashflow-forecast-rolling");
        validate(
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
            data,
            "GET /api/aggregations/cashflow-forecast-rolling",
        );
    });

    it("GET /api/aggregations/category-pivot returns expected shape", async () => {
        const data = await getEnvelope("/api/aggregations/category-pivot");
        validate(
            aggregationsEnvelope(z.object({ categoryPivot: z.record(z.unknown()) })),
            data,
            "GET /api/aggregations/category-pivot",
        );
    });

    it("GET /api/aggregations/recipient-by-year returns expected shape", async () => {
        const data = await getEnvelope("/api/aggregations/recipient-by-year");
        validate(
            aggregationsEnvelope(z.object({ recipientsByYear: z.record(z.unknown()) })),
            data,
            "GET /api/aggregations/recipient-by-year",
        );
    });

    it("GET /api/aggregations/recipient-pivot returns expected shape", async () => {
        const data = await getEnvelope("/api/aggregations/recipient-pivot");
        validate(
            aggregationsEnvelope(z.object({ recipientPivot: z.record(z.unknown()) })),
            data,
            "GET /api/aggregations/recipient-pivot",
        );
    });

    it("GET /api/aggregations/sankey returns expected shape", async () => {
        const data = await getEnvelope("/api/aggregations/sankey");
        validate(
            aggregationsEnvelope(
                z.object({
                    nodes: z.array(z.unknown()),
                    links: z.array(z.unknown()),
                    year: z.number(),
                }),
            ),
            data,
            "GET /api/aggregations/sankey",
        );
    });

    it("GET /api/aggregations/category-breakdown returns expected shape", async () => {
        const data = await getEnvelope("/api/aggregations/category-breakdown");
        validate(
            aggregationsEnvelope(z.object({ categories: z.array(z.unknown()) })),
            data,
            "GET /api/aggregations/category-breakdown",
        );
    });

    it("GET /api/aggregations/bank-balances returns expected shape", async () => {
        const data = await getEnvelope("/api/aggregations/bank-balances");
        validate(
            aggregationsEnvelope(
                z.object({
                    accounts: z.array(z.unknown()),
                    total_net_position: z.number(),
                    history: z.record(z.array(z.unknown())),
                    total_history: z.array(z.unknown()),
                }),
            ),
            data,
            "GET /api/aggregations/bank-balances",
        );
    });

    it("GET /api/aggregations/average-vs-current returns expected shape", async () => {
        const data = await getEnvelope("/api/aggregations/average-vs-current");
        validate(
            aggregationsEnvelope(z.object({ months: z.array(z.unknown()) })),
            data,
            "GET /api/aggregations/average-vs-current",
        );
    });

    it("GET /api/ai/conversations/:id returns conversation + messages", async () => {
        const data = await getEnvelope("/api/ai/conversations/conv-1");
        validate(
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
            data,
            "GET /api/ai/conversations/:id",
        );
    });

    it("GET /api/ai/models returns models array", async () => {
        const data = await getEnvelope("/api/ai/models");
        validate(z.object({ models: z.array(z.unknown()) }), data, "GET /api/ai/models");
    });

    it("GET /api/attachments/transaction/:id returns items array", async () => {
        const data = await getEnvelope("/api/attachments/transaction/1");
        validate(
            z.object({ items: z.array(z.unknown()) }),
            data,
            "GET /api/attachments/transaction/:id",
        );
    });

    it("GET /api/categories/:id returns single category", async () => {
        const data = await getEnvelope("/api/categories/1");
        validate(CategoryItemSchema, data, "GET /api/categories/:id");
    });

    it("GET /api/info/portfolio-summary returns totals shape", async () => {
        const data = await getEnvelope("/api/info/portfolio-summary");
        validate(PortfolioSummarySchema.partial({ computed_at: true }), data, "GET /api/info/portfolio-summary");
    });

    it("GET /api/investments/providers returns providers shape", async () => {
        const data = await getEnvelope("/api/investments/providers");
        validate(z.object({ providers: z.array(z.unknown()) }), data, "GET /api/investments/providers");
    });

    it("GET /api/investments/transactions returns paginated shape", async () => {
        const data = await getEnvelope("/api/investments/transactions");
        validate(
            z.object({
                items: z.array(z.unknown()),
                total: z.number().int().nonnegative(),
                limit: z.number().int().positive(),
                offset: z.number().int().nonnegative(),
                links: z.array(LinkSchema),
            }),
            data,
            "GET /api/investments/transactions",
        );
    });

    it("GET /api/investments/:id/transactions returns items+total", async () => {
        const data = await getEnvelope("/api/investments/1/transactions");
        validate(
            z.object({ items: z.array(z.unknown()), total: z.number() }),
            data,
            "GET /api/investments/:id/transactions",
        );
    });

    it("GET /api/recipients/clusters returns clusters array", async () => {
        const data = await getEnvelope("/api/recipients/clusters");
        validate(z.object({ clusters: z.array(z.unknown()) }), data, "GET /api/recipients/clusters");
    });

    it("GET /api/recipients/:id/aliases returns aliases array", async () => {
        const data = await getEnvelope("/api/recipients/1/aliases");
        validate(z.object({ aliases: z.array(z.unknown()) }), data, "GET /api/recipients/:id/aliases");
    });

    it("GET /api/recipients/:id/patterns returns paginated patterns", async () => {
        const data = await getEnvelope("/api/recipients/1/patterns");
        validate(
            z.object({ items: z.array(z.unknown()), total: z.number() }),
            data,
            "GET /api/recipients/:id/patterns",
        );
    });

    it("GET /api/saved-charts returns charts array", async () => {
        const data = await getEnvelope("/api/saved-charts");
        validate(z.object({ charts: z.array(z.unknown()) }), data, "GET /api/saved-charts");
    });

    it("GET /api/splits/transaction/:id returns items array", async () => {
        const data = await getEnvelope("/api/splits/transaction/1");
        validate(z.object({ items: z.array(z.unknown()) }), data, "GET /api/splits/transaction/:id");
    });

    it("GET /api/splits/owed/:recipientId returns items + total_owed", async () => {
        const data = await getEnvelope("/api/splits/owed/1");
        validate(
            z.object({ items: z.array(z.unknown()), total_owed: z.number() }),
            data,
            "GET /api/splits/owed/:recipientId",
        );
    });

    it("GET /api/transactions/:id returns single transaction", async () => {
        const data = await getEnvelope("/api/transactions/1");
        validate(TransactionItemSchema, data, "GET /api/transactions/:id");
    });

    it("GET /api/planned-transactions/due-soon returns array", async () => {
        const data = await getEnvelope("/api/planned-transactions/due-soon");
        validate(z.array(z.unknown()), data, "GET /api/planned-transactions/due-soon");
    });
});

describe("Phase F1: extended mutation contracts", () => {
    it("POST /api/admin/database/vacuum returns message", async () => {
        const data = await mutateEnvelope("POST", "/api/admin/database/vacuum");
        validate(z.object({ message: z.string() }), data, "POST /api/admin/database/vacuum");
    });

    it("POST /api/ai/chat returns message shape", async () => {
        const data = await mutateEnvelope("POST", "/api/ai/chat", {
            conversationId: "conv-1",
            content: "test",
        });
        validate(
            z.object({
                id: z.string(),
                conversationId: z.string(),
                role: z.string(),
                content: z.string(),
                createdAt: z.string(),
            }),
            data,
            "POST /api/ai/chat",
        );
    });

    it("POST /api/ai/conversations returns conversation+messages", async () => {
        const data = await mutateEnvelope("POST", "/api/ai/conversations", { title: "Test" });
        validate(
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
            data,
            "POST /api/ai/conversations",
        );
    });

    it("DELETE /api/ai/conversations/:id returns message", async () => {
        const data = await mutateEnvelope("DELETE", "/api/ai/conversations/conv-1");
        validate(z.object({ message: z.string() }), data, "DELETE /api/ai/conversations/:id");
    });

    it("POST /api/info/exchange-rates/refresh returns refresh result", async () => {
        const data = await mutateEnvelope("POST", "/api/info/exchange-rates/refresh");
        validate(
            z.object({ message: z.string(), rates_updated: z.number() }),
            data,
            "POST /api/info/exchange-rates/refresh",
        );
    });

    it("POST /api/info/refresh-views returns message", async () => {
        const data = await mutateEnvelope("POST", "/api/info/refresh-views");
        validate(z.object({ message: z.string() }), data, "POST /api/info/refresh-views");
    });

    it("POST /api/investments/refresh-prices returns price refresh shape", async () => {
        const data = await mutateEnvelope("POST", "/api/investments/refresh-prices");
        validate(
            z.object({
                message: z.string(),
                updated_count: z.number(),
                stale_count: z.number(),
                cached_count: z.number(),
                live: z.boolean(),
            }),
            data,
            "POST /api/investments/refresh-prices",
        );
    });

    it("POST /api/investments/:id/transactions returns single transaction", async () => {
        const data = await mutateEnvelope("POST", "/api/investments/1/transactions", {});
        validate(
            z.object({
                id: z.number(),
                investment_id: z.number(),
                type: z.string(),
                amount: z.number(),
                currency: z.string(),
            }),
            data,
            "POST /api/investments/:id/transactions",
        );
    });

    it("PATCH /api/investments/transactions/:id returns single transaction", async () => {
        const data = await mutateEnvelope("PATCH", "/api/investments/transactions/1", {});
        validate(
            z.object({
                id: z.number(),
                investment_id: z.number(),
                type: z.string(),
            }),
            data,
            "PATCH /api/investments/transactions/:id",
        );
    });

    it("DELETE /api/investments/transactions/:id returns message", async () => {
        const data = await mutateEnvelope("DELETE", "/api/investments/transactions/1");
        validate(z.object({ message: z.string() }), data, "DELETE /api/investments/transactions/:id");
    });

    it("POST /api/recipients/:id/merge returns merged shape", async () => {
        const data = await mutateEnvelope("POST", "/api/recipients/1/merge", {});
        validate(
            z.object({ message: z.string(), merged_count: z.number() }),
            data,
            "POST /api/recipients/:id/merge",
        );
    });

    it("POST /api/recipients/:id/unmerge returns message", async () => {
        const data = await mutateEnvelope("POST", "/api/recipients/1/unmerge");
        validate(z.object({ message: z.string() }), data, "POST /api/recipients/:id/unmerge");
    });

    it("POST /api/recipients/:id/patterns returns pattern shape", async () => {
        const data = await mutateEnvelope("POST", "/api/recipients/1/patterns", {});
        validate(
            z.object({
                id: z.number(),
                pattern: z.string(),
                pattern_kind: z.string(),
                case_sensitive: z.boolean(),
                priority: z.number(),
                is_active: z.boolean(),
                source: z.string(),
            }),
            data,
            "POST /api/recipients/:id/patterns",
        );
    });

    it("POST /api/recipients/:id/patterns/preview returns matches", async () => {
        const data = await mutateEnvelope("POST", "/api/recipients/1/patterns/preview", {});
        validate(z.object({ matches: z.array(z.unknown()) }), data, "POST /api/recipients/:id/patterns/preview");
    });

    it("POST /api/saved-charts returns chart shape", async () => {
        const data = await mutateEnvelope("POST", "/api/saved-charts", {});
        validate(
            z.object({
                id: z.number(),
                name: z.string(),
                config: z.unknown(),
                created_at: z.string(),
            }),
            data,
            "POST /api/saved-charts",
        );
    });

    it("PATCH /api/saved-charts/:id returns chart shape", async () => {
        const data = await mutateEnvelope("PATCH", "/api/saved-charts/1", {});
        validate(
            z.object({ id: z.number(), name: z.string() }),
            data,
            "PATCH /api/saved-charts/:id",
        );
    });

    it("DELETE /api/saved-charts/:id returns message", async () => {
        const data = await mutateEnvelope("DELETE", "/api/saved-charts/1");
        validate(z.object({ message: z.string() }), data, "DELETE /api/saved-charts/:id");
    });

    it("POST /api/splits/batch returns items", async () => {
        const data = await mutateEnvelope("POST", "/api/splits/batch", {});
        validate(z.object({ items: z.array(z.unknown()) }), data, "POST /api/splits/batch");
    });

    it("PATCH /api/splits/:id returns split shape", async () => {
        const data = await mutateEnvelope("PATCH", "/api/splits/1", {});
        validate(
            z.object({
                id: z.number(),
                transaction_id: z.number(),
                recipient_id: z.number(),
                amount: z.number(),
                is_paid: z.boolean(),
            }),
            data,
            "PATCH /api/splits/:id",
        );
    });

    it("DELETE /api/splits/:id returns message", async () => {
        const data = await mutateEnvelope("DELETE", "/api/splits/1");
        validate(z.object({ message: z.string() }), data, "DELETE /api/splits/:id");
    });

    it("POST /api/splits/:id/pay returns message", async () => {
        const data = await mutateEnvelope("POST", "/api/splits/1/pay", {});
        validate(z.object({ message: z.string() }), data, "POST /api/splits/:id/pay");
    });

    it("POST /api/splits/:id/settle returns message", async () => {
        const data = await mutateEnvelope("POST", "/api/splits/1/settle", {});
        validate(z.object({ message: z.string() }), data, "POST /api/splits/:id/settle");
    });

    it("POST /api/splits/owed/:recipientId/settle-all returns settled count", async () => {
        const data = await mutateEnvelope("POST", "/api/splits/owed/1/settle-all", {});
        validate(
            z.object({ message: z.string(), settled_count: z.number() }),
            data,
            "POST /api/splits/owed/:recipientId/settle-all",
        );
    });

    it("POST /api/watchlist returns watchlist item", async () => {
        const data = await mutateEnvelope("POST", "/api/watchlist", {});
        validate(
            z.object({
                id: z.number(),
                symbol: z.string(),
                name: z.string(),
                asset_class: z.string(),
                target_price: z.number(),
            }),
            data,
            "POST /api/watchlist",
        );
    });

    it("PATCH /api/watchlist/:id returns watchlist item", async () => {
        const data = await mutateEnvelope("PATCH", "/api/watchlist/1", {});
        validate(
            z.object({ id: z.number(), symbol: z.string() }),
            data,
            "PATCH /api/watchlist/:id",
        );
    });

    it("DELETE /api/watchlist/:id returns message", async () => {
        const data = await mutateEnvelope("DELETE", "/api/watchlist/1");
        validate(z.object({ message: z.string() }), data, "DELETE /api/watchlist/:id");
    });

    it("POST /api/planned-transactions/:id/execute returns updated planned", async () => {
        const data = await mutateEnvelope("POST", "/api/planned-transactions/1/execute", {});
        validate(PlannedTransactionItemSchema, data, "POST /api/planned-transactions/:id/execute");
    });

    it("POST /api/import/batches/:batchId/commit returns commit result", async () => {
        const data = await mutateEnvelope("POST", "/api/import/batches/1/commit", {});
        validate(
            z.object({
                message: z.string(),
                batch_id: z.number(),
                transactions_committed: z.number(),
            }),
            data,
            "POST /api/import/batches/:batchId/commit",
        );
    });

    it("PUT /api/import/batches/:batchId/rows/:rowId/override returns message", async () => {
        const data = await mutateEnvelope("PUT", "/api/import/batches/1/rows/1/override", {});
        validate(z.object({ message: z.string() }), data, "PUT override");
    });
});
