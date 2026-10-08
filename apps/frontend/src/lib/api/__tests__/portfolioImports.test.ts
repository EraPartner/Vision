// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import {
    listPortfolioParserConfigs,
    createPortfolioParserConfig,
    updatePortfolioParserConfig,
    deletePortfolioParserConfig,
    getPortfolioImportPreview,
    overridePortfolioImportRow,
    overridePortfolioImportRows,
    commitPortfolioImportBatch,
    rollbackPortfolioImportBatch,
    importPortfolioCSVCustom,
    importPortfolioCSVWithProgress,
    type PortfolioCustomConfig,
} from "@/lib/api/portfolioImports";

afterEach(() => server.resetHandlers());

describe("portfolioImports API client", () => {
    const config: PortfolioCustomConfig = {
        accountId: 7,
        dateColumn: "Date",
        typeColumn: "Type",
        symbolColumn: "Symbol",
        nameColumn: "",
        unitsColumn: "Units",
        priceColumn: "",
        amountColumn: "",
        feesColumn: "",
        taxesColumn: "",
        currencyColumn: "",
        fxRateColumn: "",
        noteColumn: "",
        dateFormat: "YYYY-MM-DD",
        separator: ",",
        encoding: "utf-8",
        skipRows: 0,
        defaultAssetClass: "stock",
        defaultType: "buy",
        typeMapping: {},
    };

    it("listPortfolioParserConfigs returns saved configs", async () => {
        server.use(
            http.get(`${API_BASE}/api/portfolio/import/parsers`, () =>
                ok({
                    items: [
                        {
                            id: 1,
                            name: "Degiro",
                            kind: "custom",
                            config,
                            created_at: "",
                            updated_at: "",
                        },
                    ],
                    total: 1,
                }),
            ),
        );
        const res = await listPortfolioParserConfigs();
        expect(res[0].name).toBe("Degiro");
    });

    it("createPortfolioParserConfig POSTs name + config", async () => {
        let body: unknown = null;
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/parsers`,
                async ({ request }) => {
                    body = await request.json();
                    return ok({
                        id: 2,
                        name: "Mine",
                        kind: "custom",
                        config,
                        created_at: "",
                        updated_at: "",
                    });
                },
            ),
        );
        const selectedConfig = {
            ...config,
            number_format: "decimal_comma" as const,
        };
        await createPortfolioParserConfig("Mine", selectedConfig);
        expect(body).toEqual({ name: "Mine", config: selectedConfig });
    });

    it.each(["auto", "decimal_dot", "decimal_comma"] as const)(
        "sends %s number parsing for staged portfolio imports",
        async (numberFormat) => {
            let body: FormData | undefined;
            server.use(
                http.post(
                    `${API_BASE}/api/portfolio/import/csv/custom`,
                    async ({ request }) => {
                        body = await request.formData();
                        return ok({
                            batch_id: 2,
                            imported: 0,
                            duplicates: 0,
                            errors: 0,
                        });
                    },
                ),
            );
            await importPortfolioCSVCustom(
                new File(["fixture"], "custom.csv"),
                { ...config, number_format: numberFormat },
                "custom",
            );
            expect(body?.get("number_format")).toBe(numberFormat);
        },
    );

    it("sends the saved number format for streaming portfolio imports", async () => {
        let body: FormData | undefined;
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/csv/stream`,
                async ({ request }) => {
                    body = await request.formData();
                    return new HttpResponse(
                        'event: complete\ndata: {"batch_id":2,"imported":0,"duplicates":0,"errors":0}\n\n',
                        { headers: { "Content-Type": "text/event-stream" } },
                    );
                },
            ),
        );
        const { result } = importPortfolioCSVWithProgress(
            new File(["fixture"], "custom.csv"),
            { ...config, number_format: "decimal_dot" },
            "custom",
            () => {},
        );
        await result;
        expect(body?.get("number_format")).toBe("decimal_dot");
    });

    it.each([false, true])(
        "preserves generic receipt identity mappings without a specialized format (stream=%s)",
        async (stream) => {
            let body: FormData | undefined;
            server.use(
                http.post(
                    `${API_BASE}/api/portfolio/import/csv/${stream ? "stream" : "custom"}`,
                    async ({ request }) => {
                        body = await request.formData();
                        return stream
                            ? new HttpResponse(
                                  'event: complete\ndata: {"batch_id":2,"imported":0,"duplicates":0,"errors":0}\n\n',
                                  {
                                      headers: {
                                          "Content-Type": "text/event-stream",
                                      },
                                  },
                              )
                            : ok({
                                  batch_id: 2,
                                  imported: 0,
                                  duplicates: 0,
                                  errors: 0,
                              });
                    },
                ),
            );
            const text =
                'Date,Type,Symbol,Units,Amount,Currency,Source_ID,Source_Account,Note,Receipt_JSON\n2025-01-01,gift,KAU,1,2,USD,SYNTHETIC-ID,SYNTHETIC-SENDER,note,"{""version"":1}"';
            const file = new File([text], "receipts.csv");
            const generic = {
                ...config,
                dateFormat: "%Y-%m-%d",
                number_format: "decimal_dot" as const,
                sourceIdColumn: "Source_ID",
                sourceAccountColumn: "Source_Account",
            };
            if (stream)
                await importPortfolioCSVWithProgress(
                    file,
                    generic,
                    "portfolio_generic",
                    () => {},
                    { isBrokerage: true, accountId: 7 },
                ).result;
            else
                await importPortfolioCSVCustom(
                    file,
                    generic,
                    "portfolio_generic",
                    { isBrokerage: true, accountId: 7 },
                );
            expect(body?.get("adapter_name")).toBe("portfolio_generic");
            expect(body?.has("portfolio_format")).toBe(false);
            expect(body?.get("source_id_column")).toBe("Source_ID");
            expect(body?.get("source_account_column")).toBe("Source_Account");
            expect(body?.get("date_format")).toBe("%Y-%m-%d");
            expect(body?.get("number_format")).toBe("decimal_dot");
            expect(body?.get("account_id")).toBe("7");
            expect(body?.get("is_brokerage")).toBe("true");
            expect(await (body?.get("file") as File).text()).toBe(text);
        },
    );

    it.each([
        "ibkr_transaction_history",
        "kinesis_transaction_history",
        "nexo_transaction_history",
        "saxo_transaction_history",
    ] as const)(
        "sends the %s selector and brokerage account in the multipart body",
        async (format) => {
            let requestedUrl = "";
            let requestedBody: FormData | undefined;
            server.use(
                http.post(
                    `${API_BASE}/api/portfolio/import/csv/custom`,
                    async ({ request }) => {
                        requestedUrl = request.url;
                        requestedBody = await request.formData();
                        return ok({
                            batch_id: 2,
                            imported: 1,
                            duplicates: 0,
                            errors: 0,
                        });
                    },
                ),
            );

            await importPortfolioCSVCustom(
                new File(["fixture"], `${format}.csv`, { type: "text/csv" }),
                { ...config, format },
                format,
                { isBrokerage: true, accountId: 7 },
            );

            expect(new URL(requestedUrl).search).toBe("");
            expect(requestedBody?.get("portfolio_format")).toBe(format);
            expect(requestedBody?.get("adapter_name")).toBe(format);
            expect(requestedBody?.get("is_brokerage")).toBe("true");
            expect(requestedBody?.get("account_id")).toBe("7");
        },
    );

    it("updatePortfolioParserConfig PATCHes by id", async () => {
        server.use(
            http.patch(`${API_BASE}/api/portfolio/import/parsers/2`, () =>
                ok({
                    id: 2,
                    name: "Renamed",
                    kind: "custom",
                    config,
                    created_at: "",
                    updated_at: "",
                }),
            ),
        );
        const res = await updatePortfolioParserConfig(2, { name: "Renamed" });
        expect(res.name).toBe("Renamed");
    });

    it("deletePortfolioParserConfig resolves on a void DELETE", async () => {
        server.use(
            http.delete(
                `${API_BASE}/api/portfolio/import/parsers/2`,
                () => new HttpResponse(null, { status: 204 }),
            ),
        );
        await expect(deletePortfolioParserConfig(2)).resolves.toBeUndefined();
    });

    it("getPortfolioImportPreview returns groups + totals", async () => {
        server.use(
            http.get(`${API_BASE}/api/portfolio/import/batches/5/preview`, () =>
                ok({
                    batch_id: 5,
                    groups: [],
                    totals: {
                        symbol: 0,
                        name_exact: 0,
                        unresolved: 0,
                        error: 0,
                    },
                }),
            ),
        );
        const res = await getPortfolioImportPreview(5);
        expect(res.batch_id).toBe(5);
    });

    it("overridePortfolioImportRow sends investment_id when not creating new", async () => {
        let body: unknown = null;
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/batches/5/rows/9/investment-override`,
                async ({ request }) => {
                    body = await request.json();
                    return ok({ row_id: 9, investment_id: 33 });
                },
            ),
        );
        await overridePortfolioImportRow(5, 9, { investmentId: 33 });
        expect(body).toMatchObject({ investment_id: 33 });
    });

    it("overridePortfolioImportRow sends create_new when createNew is set", async () => {
        let body: unknown = null;
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/batches/5/rows/9/investment-override`,
                async ({ request }) => {
                    body = await request.json();
                    return ok({ row_id: 9, created: true });
                },
            ),
        );
        await overridePortfolioImportRow(5, 9, { createNew: true });
        expect(body).toMatchObject({ create_new: true });
    });

    it("overridePortfolioImportRows sends one row-set request for an existing investment", async () => {
        let requests = 0;
        let body: unknown = null;
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/batches/5/rows/investment-override`,
                async ({ request }) => {
                    requests += 1;
                    body = await request.json();
                    return ok({
                        investment_id: 33,
                        created: false,
                        resolved: 3,
                    });
                },
            ),
        );

        const result = await overridePortfolioImportRows(5, [9, 10, 11], {
            investmentId: 33,
        });

        expect(requests).toBe(1);
        expect(body).toEqual({ row_ids: [9, 10, 11], investment_id: 33 });
        expect(result.resolved).toBe(3);
    });

    it("overridePortfolioImportRows creates once for the complete row set", async () => {
        let body: unknown = null;
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/batches/5/rows/investment-override`,
                async ({ request }) => {
                    body = await request.json();
                    return ok({
                        investment_id: 44,
                        created: true,
                        resolved: 2,
                    });
                },
            ),
        );

        await overridePortfolioImportRows(5, [9, 10], { createNew: true });

        expect(body).toEqual({ row_ids: [9, 10], create_new: true });
    });

    it("commitPortfolioImportBatch posts account_id when provided", async () => {
        let body: unknown = null;
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/batches/5/commit`,
                async ({ request }) => {
                    body = await request.json();
                    return ok({
                        batch_id: 5,
                        imported: 4,
                        duplicates: 0,
                        errors: 0,
                    });
                },
            ),
        );
        const res = await commitPortfolioImportBatch(5, 12);
        expect(body).toMatchObject({ account_id: 12 });
        expect(res.imported).toBe(4);
    });

    it("commitPortfolioImportBatch posts empty body when no account", async () => {
        let body: unknown = null;
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/batches/5/commit`,
                async ({ request }) => {
                    body = await request.json();
                    return ok({
                        batch_id: 5,
                        imported: 0,
                        duplicates: 0,
                        errors: 0,
                    });
                },
            ),
        );
        await commitPortfolioImportBatch(5);
        expect(body).toEqual({});
    });

    it("rollbackPortfolioImportBatch DELETEs and returns deleted count", async () => {
        server.use(
            http.delete(`${API_BASE}/api/portfolio/import/batches/5`, () =>
                ok({ deleted: 7 }),
            ),
        );
        expect((await rollbackPortfolioImportBatch(5)).deleted).toBe(7);
    });
});
