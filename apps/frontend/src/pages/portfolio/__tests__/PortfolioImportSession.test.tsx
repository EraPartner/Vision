// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ACCOUNT_LIST_ITEM_STUB, ok } from "@/test/msw/handlers";
import type { Account } from "@/types/api";
import {
    importPortfolioCSVWithProgress,
    previewPortfolioImportReconciliation,
} from "@/lib/api/portfolioImports";
import { PortfolioImportSession } from "../PortfolioImportSession";
import { portfolioImportPresetConfig } from "../portfolioImportPresets";

const api = "http://localhost:3002/api/portfolio/import";
const nexoHeader =
    "Transaction,Type,Input Currency,Input Amount,Output Currency,Output Amount,USD Equivalent,Date / Time (UTC)";
const proHeader =
    "id,timestamp,pair,side,type,price,executedPrice,triggerPrice,requestedAmount,filledAmount,tradingFee,feeCurrency,status,orderId";
function account(id: number, institution: string, name = institution): Account {
    return {
        ...ACCOUNT_LIST_ITEM_STUB,
        id,
        institution,
        name,
        display_name: name,
        type: "brokerage",
        is_active: true,
        funding_account_id: undefined,
        drift: undefined,
        updated_at: undefined,
    } as Account;
}
const accounts = [account(1, "Nexo"), account(2, "Saxo")];
function statement(name = "wallet.csv", pro = false) {
    return new File([pro ? proHeader : nexoHeader], name, { type: "text/csv" });
}
function staged(batchId: number) {
    return new HttpResponse(
        `event: complete\ndata: ${JSON.stringify({ batch_id: batchId, requires_review: true, imported: 0, duplicates: 0, errors: 0, skipped: 2 })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
    );
}
function plan(
    batchIds = [11],
    adoptPolicy: null | string = null,
    planFingerprint = "review-hash",
    batchPolicies: Array<{ batchId: number; adoptPolicy: string }> = [],
) {
    return {
        batchIds,
        adoptPolicy,
        batchPolicies,
        planFingerprint,
        ready: true,
        actions: [
            {
                batchId: batchIds[0],
                rowId: 1,
                rowOrdinal: 1,
                action: "adopt",
                existingTransactionId: 99,
                source: {
                    date: "2025-01-01",
                    units: "9.97",
                    amount: "19.94",
                    fees: "0.06",
                    currency: "EUR",
                },
                existing: {
                    date: "2025-01-02",
                    units: "10",
                    amount: "20",
                    fees: "0.06",
                    currency: "EUR",
                },
                corrections: ["date", "units", "amount"],
                economicsProven: true,
            },
        ],
        blockers: [],
        summary: { adopt: 1, insert: 2, duplicate_source: batchIds.length - 1 },
    };
}
function repairPlan() {
    const original = plan();
    return {
        ...original,
        actions: [
            {
                ...original.actions[0],
                action: "repair_duplicate",
                importedTransactionId: 100,
                originalBatchId: 4,
                source: {
                    ...original.actions[0].source,
                    dividend_amount_convention: "gross",
                },
                existing: {
                    ...original.actions[0].existing,
                    dividend_amount_convention: "gross",
                },
                importedExisting: {
                    date: "2025-01-01",
                    amount: "15.01",
                    units: "10.01",
                    fees: "0.01",
                    currency: "EUR",
                    dividend_amount_convention: "net",
                },
            },
        ],
        summary: { repair_duplicate: 1 },
    };
}
function referenceResult(batchIds: number[], supplementalId = 90) {
    return {
        batch_ids: [...batchIds, supplementalId].sort((a, b) => a - b),
        matched_reference_rows: 2,
        source_corrections: 1,
        replacement_batches: [] as Array<{
            original_batch_id: number;
            review_batch_id: number;
        }>,
        supplemental_batches: [
            {
                batch_id: supplementalId,
                account_id: 1,
                adapter_name: "portfolio_performance_reference",
                source_filename: "Portfolio Performance reference.xml",
                status: "awaiting_review",
                rows_total: 2,
            },
        ],
        blockers: [] as Array<{ reason: string; rowOrdinal?: number }>,
    };
}
function referenceFile(name = "reference.xml") {
    return new File(['<?xml version="1.0"?><client/>'], name, {
        type: "application/xml",
    });
}
function managedReferenceResult(
    batchIds: number[],
    reviewId = 91,
    supplementalId = 90,
) {
    const base = referenceResult(
        batchIds.filter((id) => id !== 4),
        supplementalId,
    );
    return {
        ...base,
        batch_ids: [...base.batch_ids, reviewId].sort((a, b) => a - b),
        replacement_batches: [
            { original_batch_id: 4, review_batch_id: reviewId },
        ],
        supplemental_batches: [
            ...base.supplemental_batches,
            {
                batch_id: reviewId,
                account_id: 3,
                adapter_name: "ibkr_transaction_history",
                source_filename: "Retained IBKR history review",
                status: "awaiting_review",
                rows_total: 2,
                original_batch_id: 4,
            },
        ],
    };
}
let uploads: string[];
let previews: Record<string, unknown>[];
let commits: Record<string, unknown>[];
let references: Array<{ body: string; sourceUploads: number }>;
let batchLists: number[];
beforeEach(() => {
    sessionStorage.clear();
    uploads = [];
    previews = [];
    commits = [];
    references = [];
    batchLists = [];
    server.use(
        http.post(`${api}/csv/stream`, async ({ request }) => {
            uploads.push(await request.text());
            return staged(10 + uploads.length);
        }),
        http.get(`${api}/batches/:id/preview`, ({ params }) =>
            ok({
                batch_id: Number(params.id),
                groups: [{ rows: [{ id: 1 }] }],
                totals: { error: 0, unresolved: 0 },
            }),
        ),
        http.get(`${api}/batches`, ({ request }) => {
            const offset = Number(
                new URL(request.url).searchParams.get("offset"),
            );
            batchLists.push(offset);
            return ok({
                items: [
                    {
                        id: "4",
                        account_id: 3,
                        adapter_name: "ibkr_transaction_history",
                        source_filename: "Retained IBKR export.csv",
                        status: "complete_with_errors",
                        rows_total: 2,
                        rows_error: 1,
                    },
                    {
                        id: 5,
                        account_id: 3,
                        adapter_name: "ibkr_transaction_history",
                        source_filename: "Still staging",
                        status: "staging",
                        rows_total: 2,
                        rows_error: 0,
                    },
                    {
                        id: 6,
                        account_id: 1,
                        adapter_name: "nexo_transaction_history",
                        source_filename: "Completed Nexo history.csv",
                        status: "complete",
                        rows_total: 2,
                        rows_error: 0,
                    },
                    {
                        id: 8,
                        account_id: 3,
                        adapter_name: "custom",
                        custom_config: { format: "ibkr_transaction_history" },
                        source_filename: "Retained IBKR configured.csv",
                        status: "complete",
                        rows_total: 2,
                        rows_error: 0,
                    },
                ],
                total: 4,
                limit: 50,
                offset,
            });
        }),
        http.post(`${api}/reconciliation/reference`, async ({ request }) => {
            const body = await request.text();
            references.push({
                body,
                sourceUploads: uploads.length,
            });
            const encoded = /name="batch_ids"\r\n\r\n([^\r\n]+)/.exec(body)![1];
            return ok(
                referenceResult(JSON.parse(encoded), 89 + references.length),
            );
        }),
        http.post(`${api}/reconciliation/preview`, async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            previews.push(body);
            return ok(
                plan(
                    body.batch_ids as number[],
                    (body.adopt_policy as string) ?? null,
                    "review-hash",
                    (
                        (body.batch_policies ?? []) as Array<{
                            batch_id: number;
                            adopt_policy: string;
                        }>
                    ).map((item) => ({
                        batchId: item.batch_id,
                        adoptPolicy: item.adopt_policy,
                    })),
                ),
            );
        }),
        http.post(`${api}/reconciliation/commit`, async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            commits.push(body);
            return ok({
                batches: (body.batch_ids as number[]).map((batch_id) => ({
                    batch_id,
                    imported: 2,
                    duplicates: 2,
                    adopted: 1,
                    repaired: 0,
                    errors: 0,
                })),
                imported: 2 * (body.batch_ids as number[]).length,
                duplicates: 2 * (body.batch_ids as number[]).length,
                adopted: (body.batch_ids as number[]).length,
                repaired: 0,
                errors: 0,
            });
        }),
    );
});
async function selectAndStage(
    user: ReturnType<typeof userEvent.setup>,
    files: File[] = [statement()],
) {
    await user.upload(
        await screen.findByLabelText("Statements (CSV or XLSX)"),
        files,
    );
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Stage statements" }),
        ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Stage statements" }));
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Review reconciliation" }),
        ).toBeEnabled(),
    );
}
function choosePolicy(user: ReturnType<typeof userEvent.setup>, value: string) {
    return user.selectOptions(
        screen.getByLabelText("Existing transaction facts"),
        value,
    );
}
async function chooseReference(
    user: ReturnType<typeof userEvent.setup>,
    file = referenceFile(),
) {
    await user.click(
        await screen.findByText("Optional Portfolio Performance reference"),
    );
    await user.upload(
        screen.getByLabelText("Portfolio Performance reference (XML)"),
        file,
    );
}
async function chooseExistingBatch(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
        await screen.findByText("Reconcile existing import history"),
    );
    await user.click(
        screen.getByRole("button", { name: "Load existing batches" }),
    );
    await user.selectOptions(
        await screen.findByLabelText("Existing source batch"),
        "4",
    );
    await user.click(
        screen.getByRole("button", { name: "Add selected history" }),
    );
}

describe("reviewed portfolio import sessions", () => {
    it("only includes an explicitly selected completed prior source batch and requires XML before cloning it", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession
                accounts={[...accounts, account(3, "IBKR")]}
            />,
        );
        expect(batchLists).toHaveLength(0);
        await chooseExistingBatch(user);
        expect(batchLists).toEqual([0]);
        expect(
            screen.queryByRole("option", { name: /Still staging/ }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("option", {
                name: /Completed Nexo history.csv/,
            }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("option", {
                name: /Retained IBKR configured.csv/,
            }),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Explicitly selected prior source history"),
        ).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Stage statements" }),
        ).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Review reconciliation" }),
        ).toBeDisabled();
        expect(uploads).toHaveLength(0);
        expect(previews).toHaveLength(0);
        expect(commits).toHaveLength(0);
    });

    it("accepts a completed retained IBKR batch identified by its saved format", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession accounts={[account(3, "IBKR")]} />,
        );
        await user.click(
            await screen.findByText("Reconcile existing import history"),
        );
        await user.click(
            screen.getByRole("button", { name: "Load existing batches" }),
        );
        await user.selectOptions(
            await screen.findByLabelText("Existing source batch"),
            "8",
        );
        await user.click(
            screen.getByRole("button", { name: "Add selected history" }),
        );
        expect(screen.getByText("Retained IBKR configured.csv")).toBeVisible();
        expect(
            screen.getByText("Explicitly selected prior source history"),
        ).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Stage statements" }),
        ).toBeDisabled();
        expect(previews).toHaveLength(0);
        expect(commits).toHaveLength(0);
    });

    it("uses a fresh managed review scope, carries its explicit policy, and preserves the original choice for XML restaging and resume", async () => {
        server.use(
            http.post(
                `${api}/reconciliation/reference`,
                async ({ request }) => {
                    const body = await request.text();
                    references.push({ body, sourceUploads: uploads.length });
                    const ids = JSON.parse(
                        /name="batch_ids"\r\n\r\n([^\r\n]+)/.exec(body)![1],
                    ) as number[];
                    return ok(
                        managedReferenceResult(
                            ids,
                            89 + references.length * 2,
                            88 + references.length * 2,
                        ),
                    );
                },
            ),
        );
        const user = userEvent.setup();
        const mixedAccounts = [...accounts, account(3, "IBKR")];
        const first = renderWithApp(
            <PortfolioImportSession accounts={mixedAccounts} />,
        );
        await user.upload(
            screen.getByLabelText("Statements (CSV or XLSX)"),
            statement(),
        );
        await chooseExistingBatch(user);
        await user.selectOptions(
            screen.getByLabelText("Policy for Retained IBKR export.csv"),
            "prefer_source",
        );
        await chooseReference(user);
        await user.selectOptions(
            screen.getByLabelText("Historical placeholder cost policy"),
            "zero",
        );
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        await screen.findByText(/Reference staged:/);
        expect(references[0].body).toContain('name="batch_ids"\r\n\r\n[4,11]');
        expect(uploads).toHaveLength(1);
        expect(
            screen.getByText("Original source batch remains read-only:"),
        ).toBeVisible();
        expect(screen.getByRole("link", { name: "Batch 4" })).toBeVisible();
        expect(
            screen.getByLabelText("Policy for Retained IBKR history review"),
        ).toHaveValue("prefer_source");
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await screen.findByRole("button", { name: "Import reviewed history" });
        expect(previews.at(-1)).toEqual({
            batch_ids: [11, 90, 91],
            batch_policies: [{ batch_id: 91, adopt_policy: "prefer_source" }],
        });
        await user.upload(
            screen.getByLabelText("Portfolio Performance reference (XML)"),
            referenceFile("new-reference.xml"),
        );
        expect(
            screen.queryByRole("button", { name: "Import reviewed history" }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByLabelText("Policy for Retained IBKR export.csv"),
        ).toHaveValue("prefer_source");
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        await screen.findByText(/Reference staged:/);
        expect(references[1].body).toContain('name="batch_ids"\r\n\r\n[4,12]');
        expect(references[1].body).not.toContain("[11,90,91]");
        expect(uploads).toHaveLength(2);
        first.unmount();
        renderWithApp(<PortfolioImportSession accounts={mixedAccounts} />);
        expect(
            await screen.findByLabelText(
                "Policy for Retained IBKR history review",
            ),
        ).toHaveValue("prefer_source");
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await screen.findByRole("button", { name: "Import reviewed history" });
        expect(previews.at(-1)).toEqual({
            batch_ids: [12, 92, 93],
            batch_policies: [{ batch_id: 93, adopt_policy: "prefer_source" }],
        });
        expect(commits).toHaveLength(0);
    });

    it("rejects a replacement relation that does not identify the explicitly selected original source", async () => {
        const invalid = managedReferenceResult([4, 11]);
        invalid.replacement_batches[0].original_batch_id = 99;
        server.use(
            http.post(`${api}/reconciliation/reference`, () => ok(invalid)),
        );
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession
                accounts={[...accounts, account(3, "IBKR")]}
            />,
        );
        await user.upload(
            screen.getByLabelText("Statements (CSV or XLSX)"),
            statement(),
        );
        await chooseExistingBatch(user);
        await chooseReference(user);
        await user.selectOptions(
            screen.getByLabelText("Historical placeholder cost policy"),
            "zero",
        );
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        expect(
            await screen.findByText(/reference result could not be verified/),
        ).toBeVisible();
        expect(
            screen.queryByText(
                "Managed review copy of retained source history",
            ),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Review reconciliation" }),
        ).toBeDisabled();
        expect(commits).toHaveLength(0);
    });

    it("applies the explicitly selected XML zero policy to Kinesis yield placeholders and displays asset adjustment proof", async () => {
        server.use(
            http.post(`${api}/reconciliation/preview`, () =>
                ok({
                    ...plan([11, 90]),
                    actions: [
                        {
                            batchId: 11,
                            rowId: 1,
                            rowOrdinal: 1,
                            action: "adjustment",
                            adjustment: {
                                date: "2025-01-01",
                                units: "0.02",
                                kind: "yield_reversal",
                                basisPolicy: "zero_yield_only",
                                accountId: 1,
                            },
                        },
                    ],
                    summary: { adjustment: 1 },
                }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession
                accounts={[account(1, "Kinesis"), account(2, "Saxo")]}
            />,
        );
        await user.upload(
            screen.getByLabelText("Statements (CSV or XLSX)"),
            new File(
                [
                    "DateTime,HIN,Currency_Code,Transaction_Type,Transaction_ID,Order_ID,Starting_Balance,Closing_Balance",
                ],
                "kinesis.csv",
                { type: "text/csv" },
            ),
        );
        await chooseReference(user);
        await user.selectOptions(
            screen.getByLabelText("Historical placeholder cost policy"),
            "zero",
        );
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        await screen.findByText(/Reference staged:/);
        expect(uploads[0]).toContain('name="yield_basis_policy"\r\n\r\nzero');
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(await screen.findByText("Asset adjustments")).toBeVisible();
        await user.click(
            screen.getByText("Source evidence and proposed changes"),
        );
        expect(screen.getByText("Reversal of yield units")).toBeVisible();
        expect(
            screen.getByText(
                "Consume only confirmed yield units with zero cost",
            ),
        ).toBeVisible();
        expect(screen.getByText("0.02")).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Import reviewed history" }),
        ).toBeEnabled();
        expect(commits).toHaveLength(0);
    });
    it("shows the retained and redundant imported records, including dividend convention, and reports repaired counts separately", async () => {
        server.use(
            http.post(`${api}/reconciliation/preview`, () => ok(repairPlan())),
            http.post(`${api}/reconciliation/commit`, async ({ request }) => {
                commits.push((await request.json()) as Record<string, unknown>);
                return ok({
                    batches: [
                        {
                            batch_id: 11,
                            imported: 0,
                            duplicates: 1,
                            adopted: 0,
                            repaired: 1,
                            errors: 0,
                        },
                    ],
                    imported: 0,
                    duplicates: 1,
                    adopted: 0,
                    repaired: 1,
                    errors: 0,
                });
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await selectAndStage(user);
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(
            await screen.findByText("Duplicate records to repair"),
        ).toBeVisible();
        await user.click(
            screen.getByText("Source evidence and proposed changes"),
        );
        expect(
            screen.getByText(
                /Retain existing transaction 99 and remove redundant imported transaction 100 from batch 4/,
            ),
        ).toBeVisible();
        expect(
            screen.getByRole("columnheader", {
                name: "Redundant imported record",
            }),
        ).toBeVisible();
        expect(screen.getByText("15.01")).toBeVisible();
        expect(screen.getByText("Dividend amount convention")).toBeVisible();
        expect(screen.getByText("Net")).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Import reviewed history" }),
        );
        expect(
            await screen.findByText(
                /1 duplicate records repaired; 0 unchanged duplicates/,
            ),
        ).toBeVisible();
        expect(commits[0]).toMatchObject({
            expected_plan_fingerprint: "review-hash",
        });
    });

    it.each([
        "missing_evidence",
        "foreign_scope",
        "invalid_convention",
    ] as const)("rejects duplicate repair preview with %s", async (defect) => {
        const invalid = repairPlan();
        if (defect === "missing_evidence")
            delete (invalid.actions[0] as { importedTransactionId?: number })
                .importedTransactionId;
        else if (defect === "foreign_scope") invalid.actions[0].batchId = 99;
        else
            invalid.actions[0].importedExisting.dividend_amount_convention =
                "unproved";
        server.use(
            http.post(`${api}/reconciliation/preview`, () => ok(invalid)),
        );
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await selectAndStage(user);
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(
            await screen.findByText(/response could not be verified/),
        ).toBeVisible();
        expect(
            screen.queryByRole("button", { name: "Import reviewed history" }),
        ).not.toBeInTheDocument();
        expect(commits).toHaveLength(0);
    });

    it.each(["missing", "inconsistent"] as const)(
        "rejects a commit result with %s repair counts",
        async (defect) => {
            server.use(
                http.post(
                    `${api}/reconciliation/commit`,
                    async ({ request }) => {
                        commits.push(
                            (await request.json()) as Record<string, unknown>,
                        );
                        const result = {
                            batches: [
                                {
                                    batch_id: 11,
                                    imported: 0,
                                    duplicates: 0,
                                    adopted: 0,
                                    errors: 0,
                                },
                            ],
                            imported: 0,
                            duplicates: 0,
                            adopted: 0,
                            errors: 0,
                        };
                        return ok(
                            defect === "missing"
                                ? result
                                : {
                                      ...result,
                                      repaired: 1,
                                      batches: result.batches.map((batch) => ({
                                          ...batch,
                                          repaired: 0,
                                      })),
                                  },
                        );
                    },
                ),
            );
            const user = userEvent.setup();
            renderWithApp(<PortfolioImportSession accounts={accounts} />);
            await selectAndStage(user);
            await user.click(
                screen.getByRole("button", { name: "Review reconciliation" }),
            );
            await user.click(
                await screen.findByRole("button", {
                    name: "Import reviewed history",
                }),
            );
            expect(
                await screen.findByText(/response could not be verified/),
            ).toBeVisible();
            expect(
                screen.queryByText(/new records;.*duplicate records repaired/),
            ).not.toBeInTheDocument();
            expect(commits).toHaveLength(1);
        },
    );

    it("retains a returned XML staging scope when the session unmounts during the request", async () => {
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => {
            finish = resolve;
        });
        server.use(
            http.post(
                `${api}/reconciliation/reference`,
                async ({ request }) => {
                    references.push({
                        body: await request.text(),
                        sourceUploads: uploads.length,
                    });
                    await gate;
                    return ok(referenceResult([11]));
                },
            ),
        );
        const user = userEvent.setup();
        const first = renderWithApp(
            <PortfolioImportSession accounts={accounts} />,
        );
        await user.upload(
            await screen.findByLabelText("Statements (CSV or XLSX)"),
            statement(),
        );
        await chooseReference(user);
        await user.selectOptions(
            screen.getByLabelText("Historical placeholder cost policy"),
            "zero",
        );
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        await waitFor(() => expect(references).toHaveLength(1));
        first.unmount();
        await act(async () => finish());
        await waitFor(() =>
            expect(
                JSON.parse(
                    sessionStorage.getItem(
                        "vision.portfolio-import.latest-reference.v1",
                    )!,
                ).applied.batch_ids,
            ).toEqual([11, 90]),
        );
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await user.click(
            await screen.findByRole("button", {
                name: "Review reconciliation",
            }),
        );
        await screen.findByRole("button", { name: "Import reviewed history" });
        expect(previews.at(-1)).toEqual({ batch_ids: [11, 90] });
        expect(commits).toHaveLength(0);
    });

    it("rejects a resumed XML checkpoint whose effective scope differs from the retained selected batches", async () => {
        const user = userEvent.setup();
        const first = renderWithApp(
            <PortfolioImportSession accounts={accounts} />,
        );
        await user.upload(
            await screen.findByLabelText("Statements (CSV or XLSX)"),
            statement(),
        );
        await chooseReference(user);
        await user.selectOptions(
            screen.getByLabelText("Historical placeholder cost policy"),
            "zero",
        );
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        await screen.findByText(/Reference staged:/);
        first.unmount();
        const checkpoint = JSON.parse(
            sessionStorage.getItem(
                "vision.portfolio-import.latest-reference.v1",
            )!,
        );
        checkpoint.applied.batch_ids = [11, 99];
        sessionStorage.setItem(
            "vision.portfolio-import.latest-reference.v1",
            JSON.stringify(checkpoint),
        );
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        expect(
            await screen.findByText(/reference result could not be verified/),
        ).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Review reconciliation" }),
        ).toBeDisabled();
        expect(previews).toHaveLength(0);
        expect(commits).toHaveLength(0);
    });

    it("shows a reference coverage blocker without inventing a missing row number for an empty source", async () => {
        server.use(
            http.get(`${api}/batches/11/preview`, () =>
                ok({
                    batch_id: 11,
                    groups: [],
                    totals: { error: 0, unresolved: 0 },
                }),
            ),
            http.post(`${api}/reconciliation/preview`, () =>
                ok({
                    ...plan(),
                    ready: false,
                    actions: [],
                    summary: {},
                    blockers: [
                        {
                            batchId: 11,
                            reason: "reference_unmatched_event",
                            referenceTransactionId:
                                "00000000-0000-4000-8000-000000000001",
                            candidateTransactionIds: [],
                        },
                    ],
                }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await selectAndStage(user, [statement("empty-pro.csv", true)]);
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(
            await screen.findByText(/No unique selected source event matches/),
        ).toBeVisible();
        expect(screen.queryByText(/Row undefined/)).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Import reviewed history" }),
        ).toBeDisabled();
        expect(commits).toHaveLength(0);
    });

    it("requires an explicit XML placeholder policy, stages reference after sources, and resumes its full expanded scope", async () => {
        const user = userEvent.setup();
        const first = renderWithApp(
            <PortfolioImportSession accounts={accounts} />,
        );
        await user.upload(screen.getByLabelText("Statements (CSV or XLSX)"), [
            statement(),
            statement("pro.csv", true),
        ]);
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Stage statements" }),
            ).toBeEnabled(),
        );
        await chooseReference(user);
        expect(
            screen.getByLabelText("Historical placeholder cost policy"),
        ).toHaveValue("");
        expect(
            screen.getByRole("button", { name: "Stage statements" }),
        ).toBeDisabled();
        expect(uploads).toHaveLength(0);
        await user.selectOptions(
            screen.getByLabelText("Historical placeholder cost policy"),
            "zero",
        );
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        expect(
            await screen.findByText(
                /Reference staged: 2 matched rows, 1 source corrections and 1 supplemental batches/,
            ),
        ).toBeVisible();
        expect(references).toHaveLength(1);
        expect(references[0].sourceUploads).toBe(2);
        expect(references[0].body).toContain('name="batch_ids"\r\n\r\n[11,12]');
        expect(references[0].body).toContain(
            'name="placeholder_basis_policy"\r\n\r\nzero',
        );
        expect(uploads).toHaveLength(2);
        expect(commits).toHaveLength(0);
        first.unmount();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        expect(
            await screen.findByText("Portfolio Performance reference.xml"),
        ).toBeVisible();
        expect(
            screen.getByLabelText("Historical placeholder cost policy"),
        ).toHaveValue("zero");
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        const commit = await screen.findByRole("button", {
            name: "Import reviewed history",
        });
        expect(previews.at(-1)).toEqual({ batch_ids: [11, 12, 90] });
        await user.click(commit);
        await waitFor(() =>
            expect(commits.at(-1)).toMatchObject({
                batch_ids: [11, 12, 90],
                expected_plan_fingerprint: "review-hash",
            }),
        );
        expect(
            sessionStorage.getItem(
                "vision.portfolio-import.latest-reference.v1",
            ),
        ).toBeNull();
    });

    it("invalidates and restages the source scope when XML or its placeholder policy changes", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await selectAndStage(user);
        await chooseReference(user);
        await user.selectOptions(
            screen.getByLabelText("Historical placeholder cost policy"),
            "zero",
        );
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        await screen.findByText(/Reference staged:/);
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await screen.findByRole("button", { name: "Import reviewed history" });
        expect(previews.at(-1)).toEqual({ batch_ids: [12, 90] });
        await user.upload(
            screen.getByLabelText("Portfolio Performance reference (XML)"),
            referenceFile("new-reference.xml"),
        );
        expect(
            screen.queryByRole("button", { name: "Import reviewed history" }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Review reconciliation" }),
        ).toBeDisabled();
        expect(screen.getByRole("link", { name: "Batch 90" })).toBeVisible();
        await user.selectOptions(
            screen.getByLabelText("Historical placeholder cost policy"),
            "",
        );
        expect(
            screen.getByRole("button", { name: "Stage statements" }),
        ).toBeDisabled();
        await user.selectOptions(
            screen.getByLabelText("Historical placeholder cost policy"),
            "zero",
        );
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        await screen.findByText(/Reference staged:/);
        expect(uploads).toHaveLength(3);
        expect(references).toHaveLength(2);
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await screen.findByRole("button", { name: "Import reviewed history" });
        expect(previews.at(-1)).toEqual({ batch_ids: [13, 91] });
        expect(commits).toHaveLength(0);
    });

    it("shows reference blockers and prevents commit even when the source preview is ready", async () => {
        server.use(
            http.post(`${api}/reconciliation/reference`, () =>
                ok({
                    ...referenceResult([11]),
                    blockers: [
                        { reason: "reference_unproven_basis", rowOrdinal: 7 },
                    ],
                }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await user.upload(
            screen.getByLabelText("Statements (CSV or XLSX)"),
            statement(),
        );
        await chooseReference(user);
        await user.selectOptions(
            screen.getByLabelText("Historical placeholder cost policy"),
            "zero",
        );
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        expect(
            await screen.findByText(/reference has unresolved evidence/),
        ).toBeVisible();
        expect(
            screen.getByText(/original acquisition cost is missing/),
        ).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(
            await screen.findByRole("button", {
                name: "Import reviewed history",
            }),
        ).toBeDisabled();
        expect(commits).toHaveLength(0);
    });

    it.each(["foreign_batches", "unselected_account"] as const)(
        "rejects a reference result with %s and retains only the verified source scope",
        async (defect) => {
            const invalid = referenceResult([11]);
            if (defect === "foreign_batches") invalid.batch_ids = [99, 90];
            else invalid.supplemental_batches[0].account_id = 2;
            server.use(
                http.post(`${api}/reconciliation/reference`, () => ok(invalid)),
            );
            const user = userEvent.setup();
            renderWithApp(<PortfolioImportSession accounts={accounts} />);
            await user.upload(
                screen.getByLabelText("Statements (CSV or XLSX)"),
                statement(),
            );
            await chooseReference(user);
            await user.selectOptions(
                screen.getByLabelText("Historical placeholder cost policy"),
                "zero",
            );
            await user.click(
                screen.getByRole("button", { name: "Stage statements" }),
            );
            expect(
                await screen.findByText(
                    /reference result could not be verified/,
                ),
            ).toBeVisible();
            expect(
                screen.getByRole("button", { name: "Review reconciliation" }),
            ).toBeDisabled();
            expect(
                screen.queryByText("Portfolio Performance reference.xml"),
            ).not.toBeInTheDocument();
            expect(
                JSON.parse(
                    sessionStorage.getItem(
                        "vision.portfolio-import.latest-session.v1",
                    )!,
                ),
            ).toMatchObject([{ batchId: 11 }]);
            expect(commits).toHaveLength(0);
        },
    );

    it("uses reviewed per-statement policies without guessing and carries them through the bound commit", async () => {
        const user = userEvent.setup();
        const mixedAccounts = [account(1, "Kinesis"), account(2, "Nexo")];
        renderWithApp(<PortfolioImportSession accounts={mixedAccounts} />);
        const kinesis = new File(
            [
                "DateTime,HIN,Currency_Code,Transaction_Type,Transaction_ID,Order_ID,Starting_Balance,Closing_Balance",
            ],
            "kinesis.csv",
            { type: "text/csv" },
        );
        await selectAndStage(user, [kinesis, statement("pro.csv", true)]);
        const kinesisPolicy = screen.getByLabelText("Policy for kinesis.csv");
        const proPolicy = screen.getByLabelText("Policy for pro.csv");
        expect(kinesisPolicy).toHaveValue("");
        expect(proPolicy).toHaveValue("");
        await user.selectOptions(kinesisPolicy, "preserve_existing");
        await user.selectOptions(proPolicy, "prefer_source");
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        const commit = await screen.findByRole("button", {
            name: "Import reviewed history",
        });
        expect(commit).toBeEnabled();
        const batch_policies = [
            { batch_id: 11, adopt_policy: "preserve_existing" },
            { batch_id: 12, adopt_policy: "prefer_source" },
        ];
        expect(previews.at(-1)).toEqual({
            batch_ids: [11, 12],
            batch_policies,
        });
        await user.click(commit);
        await waitFor(() =>
            expect(commits.at(-1)).toEqual({
                batch_ids: [11, 12],
                batch_policies,
                expected_plan_fingerprint: "review-hash",
            }),
        );
    });

    it("invalidates a preview on statement-policy changes, supports global fallback, and preserves overrides on resume", async () => {
        const user = userEvent.setup();
        const first = renderWithApp(
            <PortfolioImportSession accounts={accounts} />,
        );
        await selectAndStage(user, [
            statement("wallet.csv"),
            statement("pro.csv", true),
        ]);
        await choosePolicy(user, "prefer_source");
        await user.selectOptions(
            screen.getByLabelText("Policy for wallet.csv"),
            "preserve_existing",
        );
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await screen.findByRole("button", { name: "Import reviewed history" });
        expect(previews.at(-1)).toEqual({
            batch_ids: [11, 12],
            adopt_policy: "prefer_source",
            batch_policies: [
                { batch_id: 11, adopt_policy: "preserve_existing" },
            ],
        });
        await user.selectOptions(
            screen.getByLabelText("Policy for wallet.csv"),
            "prefer_source",
        );
        expect(
            screen.queryByRole("button", { name: "Import reviewed history" }),
        ).not.toBeInTheDocument();
        expect(uploads).toHaveLength(2);
        first.unmount();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        expect(
            await screen.findByLabelText("Policy for wallet.csv"),
        ).toHaveValue("prefer_source");
        await user.selectOptions(
            screen.getByLabelText("Policy for wallet.csv"),
            "",
        );
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await screen.findByRole("button", { name: "Import reviewed history" });
        expect(previews.at(-1)).toEqual({ batch_ids: [11, 12] });
        expect(commits).toHaveLength(0);
    });

    it("rejects omitted or mismatching override responses and rejects overrides outside the selected scope", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await selectAndStage(user);
        await user.selectOptions(
            screen.getByLabelText("Policy for wallet.csv"),
            "preserve_existing",
        );
        server.use(
            http.post(`${api}/reconciliation/preview`, () => ok(plan())),
        );
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(
            await screen.findByText(/response could not be verified/),
        ).toBeVisible();
        expect(
            screen.queryByRole("button", { name: "Import reviewed history" }),
        ).not.toBeInTheDocument();
        await expect(
            previewPortfolioImportReconciliation({
                batchIds: [11],
                batchPolicies: [{ batchId: 99, adoptPolicy: "prefer_source" }],
            }),
        ).rejects.toThrow(/distinct selected batches/);
        await expect(
            previewPortfolioImportReconciliation({
                batchIds: [11],
                batchPolicies: [
                    { batchId: 11, adoptPolicy: "prefer_source" },
                    { batchId: 11, adoptPolicy: "preserve_existing" },
                ],
            }),
        ).rejects.toThrow(/distinct selected batches/);
        expect(commits).toHaveLength(0);
    });

    it("shows internal movement annotations but blocks a missing companion Pro execution history", async () => {
        server.use(
            http.post(`${api}/reconciliation/preview`, () =>
                ok({
                    ...plan(),
                    ready: false,
                    actions: [
                        {
                            batchId: 11,
                            rowId: 1,
                            rowOrdinal: 1,
                            action: "internal_annotation",
                        },
                    ],
                    summary: { internal_annotation: 1 },
                    blockers: [
                        {
                            batchId: 11,
                            rowId: 1,
                            rowOrdinal: 1,
                            reason: "missing_companion_pro_history",
                            candidateTransactionIds: [],
                        },
                    ],
                }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await selectAndStage(user);
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(await screen.findByText("Internal movements")).toBeVisible();
        expect(
            screen.getByText(/Include the completed Nexo Pro trade history/),
        ).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Import reviewed history" }),
        ).toBeDisabled();
        expect(commits).toHaveLength(0);
    });

    it("stages several detected files and commits only their explicitly reviewed fingerprint and policy", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await selectAndStage(user, [
            statement("wallet.csv"),
            statement("pro.csv", true),
        ]);
        expect(uploads).toHaveLength(2);
        expect(uploads[0]).toContain("nexo_transaction_history");
        expect(uploads[1]).toContain("nexo_pro_spot_history");
        expect(uploads[0]).not.toContain("transfer_origin_account_id");
        expect(uploads[0]).not.toContain("transfer_destination_account_id");
        expect(previews).toHaveLength(0);
        expect(commits).toHaveLength(0);
        await choosePolicy(user, "prefer_source");
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        const commit = await screen.findByRole("button", {
            name: "Import reviewed history",
        });
        expect(commit).toBeEnabled();
        expect(previews).toEqual([
            { batch_ids: [11, 12], adopt_policy: "prefer_source" },
        ]);
        await user.click(
            screen.getByText("Source evidence and proposed changes"),
        );
        expect(screen.getByText("Existing transaction 99")).toBeVisible();
        expect(screen.getByText("9.97")).toBeVisible();
        expect(screen.getByText("10")).toBeVisible();
        await user.click(commit);
        await waitFor(() =>
            expect(commits).toEqual([
                {
                    batch_ids: [11, 12],
                    adopt_policy: "prefer_source",
                    expected_plan_fingerprint: "review-hash",
                },
            ]),
        );
        expect(
            await screen.findByText(
                /4 new records; 2 existing records reconciled/,
            ),
        ).toBeVisible();
        expect(
            sessionStorage.getItem("vision.portfolio-import.latest-session.v1"),
        ).toBeNull();
    });

    it("keeps repeated files and shows backend source duplicates instead of deduplicating by filename", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await selectAndStage(user, [
            statement("same.csv"),
            statement("same.csv"),
        ]);
        expect(uploads).toHaveLength(2);
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(
            await screen.findByText("Repeated source records"),
        ).toBeVisible();
        expect(previews[0]).toEqual({ batch_ids: [11, 12] });
    });

    it("uses the explicit Nexo custody account for withdrawals and returns and shows exact transfer evidence", async () => {
        server.use(
            http.post(`${api}/reconciliation/preview`, () =>
                ok({
                    ...plan(),
                    actions: [
                        {
                            batchId: 11,
                            rowId: 1,
                            rowOrdinal: 1,
                            action: "transfer",
                            transfer: {
                                date: "2025-01-01",
                                units: "10",
                                feeUnits: "0.01",
                                receivedUnits: "9.99",
                                sourceAccountId: 1,
                                destinationAccountId: 2,
                            },
                        },
                    ],
                    summary: { transfer: 1 },
                }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await user.upload(
            await screen.findByLabelText("Statements (CSV or XLSX)"),
            statement(),
        );
        await user.selectOptions(
            await screen.findByLabelText(
                "Other custody account (for asset transfers)",
            ),
            "2",
        );
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Review reconciliation" }),
            ).toBeEnabled(),
        );
        expect(uploads[0]).toContain(
            'name="transfer_destination_account_id"\r\n\r\n2',
        );
        expect(uploads[0]).toContain(
            'name="transfer_origin_account_id"\r\n\r\n2',
        );
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(await screen.findByText("Dated asset transfers")).toBeVisible();
        await user.click(
            screen.getByText("Source evidence and proposed changes"),
        );
        expect(screen.getByText("9.99")).toBeVisible();
        expect(screen.getByText("Net received units")).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Import reviewed history" }),
        ).toBeEnabled();
    });

    it("retains distinct custody origin and destination fields in the staging API", async () => {
        const config = {
            ...portfolioImportPresetConfig("nexo")!,
            transferOriginAccountId: 2,
            transferDestinationAccountId: 3,
        };
        await importPortfolioCSVWithProgress(
            statement(),
            config,
            config.format!,
            () => {},
            { isBrokerage: true, accountId: 1 },
        ).result;
        expect(uploads[0]).toContain(
            'name="transfer_origin_account_id"\r\n\r\n2',
        );
        expect(uploads[0]).toContain(
            'name="transfer_destination_account_id"\r\n\r\n3',
        );
        expect(commits).toHaveLength(0);
    });

    it("rejects malformed or differently scoped previews without exposing raw validation output", async () => {
        server.use(
            http.post(`${api}/reconciliation/preview`, () =>
                ok({ ...plan(), planFingerprint: null }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await selectAndStage(user);
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(
            await screen.findByText(/response could not be verified/),
        ).toBeVisible();
        expect(
            screen.queryByRole("button", { name: "Import reviewed history" }),
        ).not.toBeInTheDocument();
        expect(commits).toHaveLength(0);
        server.use(
            http.post(`${api}/reconciliation/preview`, () => ok(plan([999]))),
        );
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(
            await screen.findByText(/response could not be verified/),
        ).toBeVisible();
        expect(commits).toHaveLength(0);
    });

    it("blocks uncertain source or broker selection before any upload", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession
                accounts={[
                    account(1, "Nexo", "One"),
                    account(2, "Nexo", "Two"),
                ]}
            />,
        );
        await user.upload(
            await screen.findByLabelText("Statements (CSV or XLSX)"),
            statement(),
        );
        expect(
            await screen.findByText(/broker account is ambiguous/),
        ).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Stage statements" }),
        ).toBeDisabled();
        await user.upload(
            await screen.findByLabelText("Statements (CSV or XLSX)"),
            new File(["Date,Amount"], "unknown.csv", { type: "text/csv" }),
        );
        expect(
            await screen.findByText(/no supported automatic adapter/),
        ).toBeVisible();
        expect(uploads).toHaveLength(0);
        expect(commits).toHaveLength(0);
    });

    it("does not treat a stream without a review result as a successful staged statement", async () => {
        server.use(
            http.post(
                `${api}/csv/stream`,
                () =>
                    new HttpResponse("", {
                        headers: { "Content-Type": "text/event-stream" },
                    }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await user.upload(
            await screen.findByLabelText("Statements (CSV or XLSX)"),
            statement(),
        );
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Stage statements" }),
            ).toBeEnabled(),
        );
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        expect(
            await screen.findByText(/staging result could not be verified/),
        ).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Review reconciliation" }),
        ).toBeDisabled();
        expect(
            sessionStorage.getItem("vision.portfolio-import.latest-session.v1"),
        ).toBeNull();
        expect(commits).toHaveLength(0);
    });

    it("retains a returned batch when its evidence fetch fails and resumes only this selected scope", async () => {
        server.use(
            http.get(`${api}/batches/11/preview`, () =>
                HttpResponse.json(
                    {
                        ok: false,
                        error: {
                            code: "NOT_FOUND",
                            message:
                                "Review evidence is temporarily unavailable.",
                        },
                    },
                    { status: 404 },
                ),
            ),
        );
        const user = userEvent.setup();
        const first = renderWithApp(
            <PortfolioImportSession accounts={accounts} />,
        );
        await selectAndStage(user);
        expect(
            await screen.findByText(
                "Review evidence is temporarily unavailable.",
            ),
        ).toBeVisible();
        expect(screen.getByRole("link", { name: "Batch 11" })).toBeVisible();
        expect(commits).toHaveLength(0);
        first.unmount();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await user.click(
            await screen.findByRole("button", {
                name: "Review reconciliation",
            }),
        );
        await screen.findByRole("button", { name: "Import reviewed history" });
        expect(previews.at(-1)).toEqual({ batch_ids: [11] });
    });

    it("shows source blockers and never permits commit for a blocked preview", async () => {
        server.use(
            http.post(`${api}/reconciliation/preview`, () =>
                ok({
                    ...plan(),
                    ready: false,
                    blockers: [
                        {
                            batchId: 11,
                            rowId: 1,
                            rowOrdinal: 1,
                            reason: "missing_original_basis",
                            candidateTransactionIds: [],
                        },
                    ],
                }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await selectAndStage(user);
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(
            await screen.findByText(/original acquisition cost is missing/),
        ).toBeVisible();
        const commit = screen.getByRole("button", {
            name: "Import reviewed history",
        });
        expect(commit).toBeDisabled();
        await user.click(commit);
        expect(commits).toHaveLength(0);
    });

    it.each(["session", "statement"] as const)(
        "ignores an in-flight preview when the %s policy changes and requires a new matching preview",
        async (policyTarget) => {
            let finish!: () => void;
            const gate = new Promise<void>((resolve) => {
                finish = resolve;
            });
            server.use(
                http.post(
                    `${api}/reconciliation/preview`,
                    async ({ request }) => {
                        const body = (await request.json()) as Record<
                            string,
                            unknown
                        >;
                        previews.push(body);
                        if (previews.length === 1) await gate;
                        return ok(
                            plan(
                                [11],
                                (body.adopt_policy as string) ?? null,
                                `hash-${previews.length}`,
                                (
                                    (body.batch_policies ?? []) as Array<{
                                        batch_id: number;
                                        adopt_policy: string;
                                    }>
                                ).map((item) => ({
                                    batchId: item.batch_id,
                                    adoptPolicy: item.adopt_policy,
                                })),
                            ),
                        );
                    },
                ),
            );
            const user = userEvent.setup();
            renderWithApp(<PortfolioImportSession accounts={accounts} />);
            await selectAndStage(user);
            await user.click(
                screen.getByRole("button", { name: "Review reconciliation" }),
            );
            await waitFor(() => expect(previews).toHaveLength(1));
            if (policyTarget === "session")
                await choosePolicy(user, "preserve_existing");
            else
                await user.selectOptions(
                    screen.getByLabelText("Policy for wallet.csv"),
                    "preserve_existing",
                );
            await act(async () => finish());
            await waitFor(() =>
                expect(
                    screen.queryByText(
                        "Comparing source history with existing transactions…",
                    ),
                ).not.toBeInTheDocument(),
            );
            expect(
                screen.queryByRole("button", {
                    name: "Import reviewed history",
                }),
            ).not.toBeInTheDocument();
            await user.click(
                screen.getByRole("button", { name: "Review reconciliation" }),
            );
            await user.click(
                await screen.findByRole("button", {
                    name: "Import reviewed history",
                }),
            );
            await waitFor(() =>
                expect(commits[0]).toMatchObject({
                    ...(policyTarget === "session"
                        ? { adopt_policy: "preserve_existing" }
                        : {
                              batch_policies: [
                                  {
                                      batch_id: 11,
                                      adopt_policy: "preserve_existing",
                                  },
                              ],
                          }),
                    expected_plan_fingerprint: "hash-2",
                }),
            );
        },
    );

    it("invalidates a reviewed preview when files or a staged destination change", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await selectAndStage(user);
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await screen.findByRole("button", { name: "Import reviewed history" });
        await user.click(screen.getByRole("button", { name: "Change" }));
        await user.click(screen.getByRole("combobox", { name: "Broker" }));
        await user.click(await screen.findByRole("option", { name: "Saxo" }));
        expect(
            screen.queryByRole("button", { name: "Import reviewed history" }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByText(/earlier version has a separate pending batch/),
        ).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Review reconciliation" }),
            ).toBeEnabled(),
        );
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await screen.findByRole("button", { name: "Import reviewed history" });
        expect(previews.at(-1)).toEqual({ batch_ids: [12] });
        await user.upload(
            await screen.findByLabelText("Statements (CSV or XLSX)"),
            statement("another.csv"),
        );
        expect(
            screen.queryByRole("button", { name: "Import reviewed history" }),
        ).not.toBeInTheDocument();
        expect(commits).toHaveLength(0);
    });

    it("clears the preview after a server stale-plan rejection without retrying commit", async () => {
        server.use(
            http.post(`${api}/reconciliation/commit`, async ({ request }) => {
                commits.push((await request.json()) as Record<string, unknown>);
                return HttpResponse.json(
                    {
                        ok: false,
                        error: {
                            code: "CONFLICT",
                            message:
                                "The reviewed source changed. Preview again.",
                            details: { reason: "stale_reconciliation_plan" },
                        },
                    },
                    { status: 409 },
                );
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await selectAndStage(user);
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await user.click(
            await screen.findByRole("button", {
                name: "Import reviewed history",
            }),
        );
        expect(
            await screen.findByText(
                "The reviewed source changed. Preview again.",
            ),
        ).toBeVisible();
        expect(commits).toHaveLength(1);
        expect(
            screen.queryByRole("button", { name: "Import reviewed history" }),
        ).not.toBeInTheDocument();
    });

    it("stages serially and stops only after recording the current returned batch", async () => {
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => {
            finish = resolve;
        });
        server.use(
            http.post(`${api}/csv/stream`, async ({ request }) => {
                uploads.push(await request.text());
                await gate;
                return staged(11);
            }),
        );
        const user = userEvent.setup();
        const first = renderWithApp(
            <PortfolioImportSession accounts={accounts} />,
        );
        await user.upload(
            await screen.findByLabelText("Statements (CSV or XLSX)"),
            [statement("one.csv"), statement("two.csv")],
        );
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Stage statements" }),
            ).toBeEnabled(),
        );
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        await waitFor(() => expect(uploads).toHaveLength(1));
        await user.click(
            screen.getByRole("button", {
                name: "Stop after current statement",
            }),
        );
        await act(async () => finish());
        expect(
            await screen.findByText(/Stopped after the current statement/),
        ).toBeVisible();
        expect(uploads).toHaveLength(1);
        expect(commits).toHaveLength(0);
        expect(screen.getByRole("link", { name: "Batch 11" })).toBeVisible();
        first.unmount();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        expect(screen.getByText("one.csv")).toBeVisible();
        expect(screen.queryByText("two.csv")).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Review reconciliation" }),
        ).toBeEnabled();
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await screen.findByRole("button", { name: "Import reviewed history" });
        expect(previews.at(-1)).toEqual({ batch_ids: [11] });
        expect(
            within(
                screen.getByRole("region", { name: "Reconciliation review" }),
            ).getByText("Existing transactions to reconcile"),
        ).toBeVisible();
    });
});
