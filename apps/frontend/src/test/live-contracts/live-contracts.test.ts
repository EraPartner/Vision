/**
 * Live-backend contract tests (E5)
 *
 * Hit the real backend and validate response shapes against the same Zod
 * schemas used in MSW fixture contracts.  Catches divergence between the MSW
 * stubs and actual backend responses BEFORE the fix lands in CI.
 *
 * Skipped automatically when LIVE_API_BASE is not set (normal unit-test runs).
 * In CI the `test-live-api-contracts` job sets LIVE_API_BASE=http://localhost:3002
 * and starts a full Docker Compose stack before running this file.
 */
// @vitest-environment node
import { describe, it, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { server } from "@/test/msw/server";

const LIVE_BASE = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LIVE_API_BASE ?? "";
const enabled = Boolean(LIVE_BASE);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function get(path: string): Promise<unknown> {
    const res = await fetch(`${LIVE_BASE}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for GET ${path}`);
    const json = (await res.json()) as { ok: boolean; data: unknown };
    if (!json.ok) throw new Error(`envelope.ok=false for GET ${path}`);
    return json.data;
}

function validate<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
    const result = schema.safeParse(data);
    if (!result.success) {
        throw new Error(`Contract violation [${label}]:\n${result.error.toString()}`);
    }
    return result.data;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const LinkSchema = z.object({ rel: z.string(), href: z.string() });

const paginatedOf = <T extends z.ZodTypeAny>(item: T) =>
    z.object({
        items: z.array(item),
        total: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
        offset: z.number().int().nonnegative(),
        links: z.array(LinkSchema),
    });

/** `{ items, total }` — the canonical body for unpaginated collection GETs. */
const collectionSchema = (item: z.ZodTypeAny = z.unknown()) =>
    z.object({ items: z.array(item), total: z.number().int().nonnegative() });

const CategoryItemSchema = z.object({
    id: z.number().int(),
    general: z.string().min(1),
    detail: z.string().min(1),
    is_active: z.boolean(),
});

const RecipientItemSchema = z.object({
    id: z.number().int(),
    name: z.string().min(1),
    is_active: z.boolean(),
});

const TransactionItemSchema = z.object({
    id: z.number().int(),
    transaction_date: z.string(),
    amount: z.number(),
    currency: z.string(),
    is_active: z.boolean(),
});

const InvestmentItemSchema = z.object({
    id: z.number().int(),
    name: z.string().min(1),
    is_active: z.boolean(),
});

// meta.source includes "mv" for materialized-view-backed aggregation endpoints
const MetaSourceSchema = z.enum(["live", "cache", "mv"]);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.skipIf(!enabled)("Live backend API contracts (E5)", () => {
    beforeAll(() => server.close());
    afterAll(() => server.listen({ onUnhandledRequest: "error" }));

    it("GET /api/info/health returns status ok", async () => {
        const res = await fetch(`${LIVE_BASE}/health`);
        const json = (await res.json()) as { status: string };
        validate(z.object({ status: z.string() }), json, "GET /health");
    });

    // NOTE: the bare `GET /api/info` statistics index was the legacy stats route.
    // It was removed in the ADR-010 Phase 9 cutover (see apps/node-backend/src/
    // routes/aggregations.js) — permanently replaced by the `/api/aggregations/*`
    // endpoints (covered below) — and is not present in openapi.yaml. There is no
    // contract to assert for it, so no test here; the subroutes /api/info/* and
    // the aggregation endpoints carry the coverage.

    it("GET /api/categories returns paginated list", async () => {
        const data = await get("/api/categories");
        validate(paginatedOf(CategoryItemSchema), data, "GET /api/categories");
    });

    it("GET /api/recipients returns paginated list", async () => {
        const data = await get("/api/recipients");
        validate(paginatedOf(RecipientItemSchema), data, "GET /api/recipients");
    });

    it("GET /api/transactions returns paginated list", async () => {
        const data = await get("/api/transactions");
        validate(paginatedOf(TransactionItemSchema), data, "GET /api/transactions");
    });

    it("GET /api/investments returns paginated list", async () => {
        const data = await get("/api/investments");
        validate(paginatedOf(InvestmentItemSchema), data, "GET /api/investments");
    });

    it("GET /api/aggregations/monthly-summary returns expected shape", async () => {
        const data = await get("/api/aggregations/monthly-summary");
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
                    source: MetaSourceSchema,
                }),
            }),
            data,
            "GET /api/aggregations/monthly-summary",
        );
    });

    it("GET /api/info/portfolio-summary returns totals shape", async () => {
        const data = await get("/api/info/portfolio-summary");
        validate(
            z.object({
                currency: z.string(),
                totals: z.object({
                    totalPortfolioValue: z.number(),
                    totalInvested: z.number(),
                    totalGainLoss: z.number(),
                }),
                summaries: z.array(z.unknown()),
            }),
            data,
            "GET /api/info/portfolio-summary",
        );
    });

    it("GET /api/info/exchange-rates returns rates object", async () => {
        const data = await get("/api/info/exchange-rates");
        validate(
            z.object({
                rates: z.array(z.unknown()),
                total_rates: z.number(),
            }).passthrough(),
            data,
            "GET /api/info/exchange-rates",
        );
    });

    it("GET /api/info/transaction-count returns count object", async () => {
        const data = await get("/api/info/transaction-count");
        validate(z.object({ total_transactions: z.number() }), data, "GET /api/info/transaction-count");
    });

    it("GET /api/ai/status returns enabled flag", async () => {
        const data = await get("/api/ai/status");
        validate(
            z.object({
                ok: z.boolean(),
                enabled: z.boolean(),
            }),
            data,
            "GET /api/ai/status",
        );
    });

    it("GET /api/settings returns object", async () => {
        const data = await get("/api/settings");
        validate(z.record(z.string(), z.unknown()), data, "GET /api/settings");
    });

    it("GET /api/watchlist returns paginated shape", async () => {
        const data = await get("/api/watchlist");
        validate(
            z.object({
                items: z.array(z.unknown()),
                total: z.number(),
            }),
            data,
            "GET /api/watchlist",
        );
    });

    // ─── Phase F1: extended live contract coverage ──────────────────────────

    it("GET /api/planned-transactions returns paginated shape", async () => {
        const data = await get("/api/planned-transactions");
        validate(
            z.object({
                items: z.array(z.unknown()),
                total: z.number().int().nonnegative(),
            }),
            data,
            "GET /api/planned-transactions",
        );
    });

    it("GET /api/planned-transactions/due-soon returns array", async () => {
        const data = await get("/api/planned-transactions/due-soon");
        validate(z.array(z.unknown()), data, "GET /api/planned-transactions/due-soon");
    });

    it("GET /api/aggregations/category-breakdown returns expected shape", async () => {
        const data = await get("/api/aggregations/category-breakdown");
        validate(
            z.object({
                data: z.object({ categories: z.array(z.unknown()) }),
                meta: z.object({ source: MetaSourceSchema }).passthrough(),
            }),
            data,
            "GET /api/aggregations/category-breakdown",
        );
    });

    it("GET /api/aggregations/recipient-insights returns expected shape", async () => {
        const data = await get("/api/aggregations/recipient-insights");
        validate(
            z.object({
                data: z.object({
                    topMerchants: z.array(z.unknown()),
                    monthOverMonth: z.array(z.unknown()),
                }),
                meta: z.object({ source: MetaSourceSchema }).passthrough(),
            }),
            data,
            "GET /api/aggregations/recipient-insights",
        );
    });

    it("GET /api/aggregations/cashflow-comparison returns expected shape", async () => {
        const data = await get("/api/aggregations/cashflow-comparison");
        validate(
            z.object({
                data: z.object({
                    days_in_month: z.number(),
                    current_day: z.number(),
                    month: z.number(),
                    year: z.number(),
                    without_planned: z.array(z.unknown()),
                    with_planned: z.array(z.unknown()),
                }),
                meta: z.object({ source: MetaSourceSchema }).passthrough(),
            }),
            data,
            "GET /api/aggregations/cashflow-comparison",
        );
    });

    it("GET /api/aggregations/bank-balances returns expected shape", async () => {
        const data = await get("/api/aggregations/bank-balances");
        validate(
            z.object({
                data: z.object({
                    accounts: z.array(z.unknown()),
                    total_net_position: z.number(),
                    history: z.record(z.string(), z.array(z.unknown())),
                    total_history: z.array(z.unknown()),
                }),
                meta: z.object({ source: MetaSourceSchema }).passthrough(),
            }),
            data,
            "GET /api/aggregations/bank-balances",
        );
    });

    it("GET /api/aggregations/sankey returns expected shape", async () => {
        const data = await get("/api/aggregations/sankey");
        validate(
            z.object({
                data: z.object({
                    nodes: z.array(z.unknown()),
                    links: z.array(z.unknown()),
                    year: z.number(),
                }),
                meta: z.object({ source: MetaSourceSchema }).passthrough(),
            }),
            data,
            "GET /api/aggregations/sankey",
        );
    });

    it("GET /api/info/portfolio-performance returns expected shape", async () => {
        const data = await get("/api/info/portfolio-performance");
        validate(
            z.object({
                currency: z.string(),
                start_date: z.string(),
                end_date: z.string(),
                snapshots: z.array(z.unknown()),
                metrics: z.unknown().nullable(),
                heatmap: z.unknown(),
                breakdownSummary: z.array(z.unknown()),
                totals: z.unknown(),
            }),
            data,
            "GET /api/info/portfolio-performance",
        );
    });

    it("GET /api/info/net-worth returns expected shape", async () => {
        const data = await get("/api/info/net-worth");
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

    it("GET /api/info/banks returns banks object", async () => {
        const data = await get("/api/info/banks");
        validate(z.object({ banks: z.array(z.unknown()) }), data, "GET /api/info/banks");
    });

    it("GET /api/info/supported-adapters returns adapters object", async () => {
        const data = await get("/api/info/supported-adapters");
        validate(
            z.object({ adapters: z.array(z.unknown()), total_count: z.number() }),
            data,
            "GET /api/info/supported-adapters",
        );
    });

    it("GET /api/info/recurring-patterns returns patterns object", async () => {
        const data = await get("/api/info/recurring-patterns");
        validate(
            z.object({ patterns: z.array(z.unknown()), total: z.number() }),
            data,
            "GET /api/info/recurring-patterns",
        );
    });

    it("GET /api/info/inflation-rates returns rates object", async () => {
        const data = await get("/api/info/inflation-rates");
        validate(
            z.object({ rates: z.array(z.unknown()), source: z.string() }).passthrough(),
            data,
            "GET /api/info/inflation-rates",
        );
    });

    it("GET /api/admin/endpoint-liveness returns { items, total }", async () => {
        const data = await get("/api/admin/endpoint-liveness");
        validate(collectionSchema(), data, "GET /api/admin/endpoint-liveness");
    });

    it("GET /api/admin/database/stats returns shape", async () => {
        const data = await get("/api/admin/database/stats");
        validate(
            z.object({
                tables: z.array(z.unknown()),
                db_size: z.string().nullable(),
            }),
            data,
            "GET /api/admin/database/stats",
        );
    });

    it("GET /api/admin/providers/health returns { items, total }", async () => {
        const data = await get("/api/admin/providers/health");
        validate(collectionSchema(), data, "GET /api/admin/providers/health");
    });

    it("GET /api/admin/metrics/requests returns array", async () => {
        const data = await get("/api/admin/metrics/requests");
        validate(z.array(z.unknown()), data, "GET /api/admin/metrics/requests");
    });

    it("GET /api/admin/endpoints returns { items, total }", async () => {
        const data = await get("/api/admin/endpoints");
        validate(collectionSchema(), data, "GET /api/admin/endpoints");
    });

    it("GET /api/import/batches returns { items, total, limit, offset }", async () => {
        const data = await get("/api/import/batches");
        validate(
            z.object({
                items: z.array(z.unknown()),
                total: z.number().int().nonnegative(),
                limit: z.number().int().positive(),
                offset: z.number().int().nonnegative(),
            }),
            data,
            "GET /api/import/batches",
        );
    });

    it("GET /api/splits/owed returns shape", async () => {
        const data = await get("/api/splits/owed");
        validate(z.object({ items: z.array(z.unknown()) }), data, "GET /api/splits/owed");
    });

    it("GET /api/saved-charts returns { items, total }", async () => {
        const data = await get("/api/saved-charts");
        validate(collectionSchema(), data, "GET /api/saved-charts");
    });

    it("GET /api/recipients/clusters returns clusters", async () => {
        const data = await get("/api/recipients/clusters");
        validate(z.object({ items: z.array(z.unknown()) }), data, "GET /api/recipients/clusters");
    });

    // (GET /api/info/transaction-summary removed — Phase 9 cutover deleted the route.)

    it("GET /api/market/news returns articles array", async () => {
        const data = await get("/api/market/news");
        validate(z.object({ articles: z.array(z.unknown()) }), data, "GET /api/market/news");
    });
});
