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
import { ibkrFundingStatement } from "./fixtures/ibkrFundingStatement";
import { asAccountId } from "@vision/types/brands";

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
function kinesisStatement(name = "kinesis.csv") {
    return new File(
        [
            "DateTime,HIN,Currency_Code,Transaction_Type,Transaction_ID,Order_ID,Starting_Balance,Closing_Balance",
        ],
        name,
        { type: "text/csv" },
    );
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
    batchPolicies: Array<{ batchId: number; adoptPolicy: string }> = [],
) {
    return {
        batchIds,
        adoptPolicy,
        batchPolicies,
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
let uploads: string[];
let previews: Record<string, unknown>[];
let commits: Record<string, unknown>[];
beforeEach(() => {
    sessionStorage.clear();
    uploads = [];
    previews = [];
    commits = [];
    server.use(
        http.post(`${api}/csv/stream`, async ({ request }) => {
            uploads.push(await request.text());
            return staged(10 + uploads.length);
        }),
        http.get(`${api}/batches/:id/preview`, ({ params }) =>
            ok({
                batch_id: Number(params.id),
                account_id: 1,
                account_name: "Nexo",
                account_valid: true,
                groups: [
                    {
                        is_cash: false,
                        investment_id: 1,
                        investment_name: "Synthetic asset",
                        investment_symbol: "SYNTH",
                        investment_asset_class: "crypto",
                        raw_symbol: "SYNTH",
                        raw_name: null,
                        row_count: 1,
                        rows: [
                            {
                                id: "1",
                                row_index: 0,
                                status: "matched",
                                route: "portfolio",
                                tx_date: "2025-01-01",
                                type: "buy",
                                type_raw: "Buy",
                                symbol_raw: "SYNTH",
                                name_raw: null,
                                units: "1",
                                price_per_unit: "2",
                                amount: "2",
                                fees: "0",
                                taxes: "0",
                                currency: "EUR",
                                fx_rate_to_eur: "1",
                                note: null,
                                match_source: "symbol",
                                error_message: null,
                                user_override_investment_id: null,
                            },
                        ],
                    },
                ],
                totals: { symbol: 1, name_exact: 0, unresolved: 0, error: 0 },
            }),
        ),
        http.post(`${api}/reconciliation/preview`, async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            previews.push(body);
            return ok(
                plan(
                    body.batch_ids as number[],
                    (body.adopt_policy as string) ?? null,
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
                    duplicates: 1,
                    adopted: 1,
                    errors: 0,
                })),
                imported: 2 * (body.batch_ids as number[]).length,
                duplicates: (body.batch_ids as number[]).length,
                adopted: (body.batch_ids as number[]).length,
                errors: 0,
            });
        }),
    );
});
async function selectAndStage(
    user: ReturnType<typeof userEvent.setup>,
    files: File[] = [statement()],
) {
    await user.upload(await screen.findByLabelText(/Statements \(CSV/), files);
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Prepare for review" }),
        ).toBeEnabled(),
    );
    await user.click(
        screen.getByRole("button", { name: "Prepare for review" }),
    );
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Review reconciliation" }),
        ).toBeEnabled(),
    );
}
type User = ReturnType<typeof userEvent.setup>;
/** Option labels of the session policy Select, by model value. */
const policyLabels = {
    auto: "Automatic exact matches",
    preserve_existing: "Preserve existing facts",
    prefer_source: "Use detailed source facts",
} as const;
/** Option labels of a per-statement policy Select; "" defers to the session. */
const statementPolicyLabels = {
    "": "Use session policy",
    preserve_existing: policyLabels.preserve_existing,
    prefer_source: policyLabels.prefer_source,
} as const;
const policyField = () => screen.getByLabelText("Existing transaction facts");
const statementPolicyField = (file: string) =>
    screen.getByLabelText(`Policy for ${file}`);

/** Picks an option of a design-system (Radix) Select by its visible label. */
async function pickOption(
    user: User,
    trigger: HTMLElement,
    name: string | RegExp,
) {
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name }));
}
function choosePolicy(user: User, value: keyof typeof policyLabels) {
    return pickOption(user, policyField(), policyLabels[value]);
}
function chooseStatementPolicy(
    user: User,
    file: string,
    value: keyof typeof statementPolicyLabels,
) {
    return pickOption(
        user,
        statementPolicyField(file),
        statementPolicyLabels[value],
    );
}
describe("reviewed portfolio import sessions", () => {
    it("stages a CSV-only Kinesis statement with the zero yield-basis policy and reviews it as full history", async () => {
        let upload = "";
        server.use(
            http.post(`${api}/csv/stream`, async ({ request }) => {
                upload = await request.text();
                return staged(11);
            }),
        );
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession accounts={[account(1, "Kinesis")]} />,
        );
        await selectAndStage(user, [kinesisStatement()]);
        expect(upload).toContain(
            'name="portfolio_format"\r\n\r\nkinesis_transaction_history',
        );
        expect(upload).toContain('name="account_id"\r\n\r\n1');
        expect(upload).toContain('name="yield_basis_policy"\r\n\r\nzero');
        expect(
            screen.queryByLabelText("Reconciliation scope"),
        ).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(
            await screen.findByRole("button", {
                name: "Import reviewed history",
            }),
        ).toBeEnabled();
        expect(previews).toEqual([{ batch_ids: [11] }]);
        expect(commits).toHaveLength(0);
    });
    it("shows source and existing values, including dividend convention, before adopting", async () => {
        const reviewed = plan();
        const [action] = reviewed.actions;
        if (!action) throw new Error("plan fixture has no action");
        server.use(
            http.post(`${api}/reconciliation/preview`, () =>
                ok({
                    ...reviewed,
                    actions: [
                        {
                            ...action,
                            source: {
                                ...action.source,
                                dividend_amount_convention: "gross",
                            },
                            existing: {
                                ...action.existing,
                                dividend_amount_convention: "net",
                            },
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
        await user.click(
            await screen.findByText("Source evidence and proposed changes"),
        );
        expect(screen.getByText("Existing transaction 99")).toBeVisible();
        expect(screen.getByText("Dividend amount convention")).toBeVisible();
        expect(screen.getByText("Gross")).toBeVisible();
        expect(screen.getByText("Net")).toBeVisible();
        expect(
            screen.queryByText("Duplicate records to repair"),
        ).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("button", { name: "Import reviewed history" }),
        );
        expect(
            await screen.findByText(
                "2 new records; 1 existing records reconciled; 1 unchanged duplicates.",
            ),
        ).toBeVisible();
        expect(commits).toEqual([{ batch_ids: [11] }]);
    });
    it.each(["missing_existing", "foreign_scope", "invalid_convention"] as const)(
        "rejects an adoption preview with %s",
        async (defect) => {
            const invalid = plan();
            const [action] = invalid.actions;
            if (!action) throw new Error("plan fixture has no action");
            if (defect === "missing_existing")
                delete (action as { existingTransactionId?: number })
                    .existingTransactionId;
            else if (defect === "foreign_scope") action.batchId = 99;
            else
                (action.existing as Record<string, string>)
                    .dividend_amount_convention = "unproved";
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
                screen.queryByRole("button", {
                    name: "Import reviewed history",
                }),
            ).not.toBeInTheDocument();
            expect(commits).toHaveLength(0);
        },
    );
    it("lets the owner keep a row that resembles an existing transaction and commits that choice", async () => {
        server.use(
            http.post(`${api}/reconciliation/preview`, async ({ request }) => {
                const body = (await request.json()) as Record<string, unknown>;
                previews.push(body);
                const choices = (body.row_choices ?? []) as Array<{
                    batch_id: number;
                    row_id: number;
                    choice: string;
                }>;
                const reviewed = {
                    ...plan(),
                    rowChoices: choices.map((item) => ({
                        batchId: item.batch_id,
                        rowId: item.row_id,
                        choice: item.choice,
                    })),
                };
                if (choices.length > 0) return ok(reviewed);
                const blocker = {
                    batchId: 11,
                    rowId: 1,
                    rowOrdinal: 1,
                    reason: "existing_assigned_or_imported_history",
                    candidateTransactionIds: [99],
                };
                return ok({
                    ...reviewed,
                    ready: false,
                    actions: [{ ...blocker, action: "blocked" }],
                    blockers: [blocker],
                    summary: { blocked: 1 },
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
            await screen.findByText(
                /resembles a transaction this account already holds/,
            ),
        ).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Same transaction" }),
        ).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Keep both" }));
        await user.click(
            await screen.findByRole("button", {
                name: "Import reviewed history",
            }),
        );
        await screen.findByText(/new records;/);
        const choice = {
            row_choices: [{ batch_id: 11, row_id: 1, choice: "keep_both" }],
        };
        expect(previews.at(-1)).toMatchObject(choice);
        expect(commits).toEqual([{ batch_ids: [11], ...choice }]);
    });
    it("asks per row about a Saxo pair without a booking record id and commits that answer", async () => {
        server.use(
            http.post(`${api}/reconciliation/preview`, async ({ request }) => {
                const body = (await request.json()) as Record<string, unknown>;
                previews.push(body);
                const choices = (body.row_choices ?? []) as Array<{
                    batch_id: number;
                    row_id: number;
                    choice: string;
                }>;
                const reviewed = {
                    ...plan(),
                    rowChoices: choices.map((item) => ({
                        batchId: item.batch_id,
                        rowId: item.row_id,
                        choice: item.choice,
                    })),
                };
                if (choices.length > 0) return ok(reviewed);
                const blocker = {
                    batchId: 11,
                    rowId: 1,
                    rowOrdinal: 1,
                    reason: "cross_format_identity_missing",
                    candidateTransactionIds: [99],
                };
                return ok({
                    ...reviewed,
                    ready: false,
                    actions: [{ ...blocker, action: "blocked" }],
                    blockers: [blocker],
                    summary: { blocked: 1 },
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
            await screen.findByText(/no booking record id.*"Keep both"/),
        ).toBeVisible();
        expect(screen.getByRole("button", { name: "Keep both" })).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Same transaction" }),
        );
        await user.click(
            await screen.findByRole("button", {
                name: "Import reviewed history",
            }),
        );
        await screen.findByText(/new records;/);
        const choice = {
            row_choices: [
                { batch_id: 11, row_id: 1, choice: "same_transaction" },
            ],
        };
        expect(previews.at(-1)).toMatchObject(choice);
        expect(commits).toEqual([{ batch_ids: [11], ...choice }]);
    });
    it("offers only Keep both when several Saxo look-alikes cannot be matched one to one", async () => {
        server.use(
            http.post(`${api}/reconciliation/preview`, async ({ request }) => {
                previews.push((await request.json()) as Record<string, unknown>);
                const blocker = {
                    batchId: 11,
                    rowId: 1,
                    rowOrdinal: 1,
                    reason: "cross_format_identity_ambiguous",
                    candidateTransactionIds: [],
                };
                return ok({
                    ...plan(),
                    ready: false,
                    actions: [{ ...blocker, action: "blocked" }],
                    blockers: [blocker],
                    summary: { blocked: 1 },
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
            await screen.findByText(/cannot be matched one to one/),
        ).toBeVisible();
        expect(screen.getByRole("button", { name: "Keep both" })).toBeVisible();
        expect(
            screen.queryByRole("button", { name: "Same transaction" }),
        ).toBeNull();
    });
    it.each(["inconsistent_totals"] as const)(
        "rejects a commit result with %s",
        async () => {
            server.use(
                http.post(
                    `${api}/reconciliation/commit`,
                    async ({ request }) => {
                        commits.push(
                            (await request.json()) as Record<string, unknown>,
                        );
                        const batch = {
                            batch_id: 11,
                            imported: 0,
                            duplicates: 1,
                            adopted: 0,
                            errors: 0,
                        };
                        return ok({
                            batches: [batch],
                            imported: 0,
                            duplicates: 2,
                            adopted: batch.adopted,
                            errors: 0,
                        });
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
                screen.queryByText(/new records;/),
            ).not.toBeInTheDocument();
            expect(commits).toHaveLength(1);
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
        expect(kinesisPolicy).toHaveTextContent(statementPolicyLabels[""]);
        expect(proPolicy).toHaveTextContent(statementPolicyLabels[""]);
        await pickOption(user, kinesisPolicy, policyLabels.preserve_existing);
        await pickOption(user, proPolicy, policyLabels.prefer_source);
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
        await chooseStatementPolicy(user, "wallet.csv", "preserve_existing");
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
        await chooseStatementPolicy(user, "wallet.csv", "prefer_source");
        expect(
            screen.queryByRole("button", { name: "Import reviewed history" }),
        ).not.toBeInTheDocument();
        expect(uploads).toHaveLength(2);
        first.unmount();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        expect(
            await screen.findByLabelText("Policy for wallet.csv"),
        ).toHaveTextContent(policyLabels.prefer_source);
        await chooseStatementPolicy(user, "wallet.csv", "");
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await screen.findByRole("button", { name: "Import reviewed history" });
        expect(previews.at(-1)).toEqual({
            batch_ids: [11, 12],
            adopt_policy: "prefer_source",
        });
        expect(commits).toHaveLength(0);
    });

    it("rejects omitted or mismatching override responses and rejects overrides outside the selected scope", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioImportSession accounts={accounts} />);
        await selectAndStage(user);
        await chooseStatementPolicy(user, "wallet.csv", "preserve_existing");
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

    it("stages several detected files and commits only their explicitly reviewed scope and policy", async () => {
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

    it.each(["biff8", "xlsx"] as const)(
        "stages an IBKR %s funding workbook with its own parser",
        async (format) => {
            const user = userEvent.setup();
            renderWithApp(
                <PortfolioImportSession
                    accounts={[...accounts, account(3, "IBKR")]}
                />,
            );
            const input = await screen.findByLabelText(/Statements \(CSV/);
            expect(input).toHaveAttribute("accept", ".csv,.xlsx,.xls");
            await selectAndStage(user, [ibkrFundingStatement(format)]);
            expect(screen.getByText("IBKR funding history")).toBeVisible();
            expect(
                screen.queryByLabelText("Assets to include"),
            ).not.toBeInTheDocument();
            expect(uploads).toHaveLength(1);
            expect(uploads[0]).toContain("ibkr_funding_history");
            expect(uploads[0]).not.toContain("included_symbols");
        },
    );

    it("reviews in-kind income as a new record beside its zero-basis Gift and settled cash", async () => {
        const units = {
            type: "gift",
            date: "2025-01-01",
            units: "0.01",
            amount: "0",
            price_per_unit: "0",
            fees: "0",
            taxes: "0",
            currency: "USD",
        };
        server.use(
            http.post(`${api}/reconciliation/preview`, async ({ request }) => {
                const body = (await request.json()) as Record<string, unknown>;
                previews.push(body);
                return ok({
                    ...plan([11], "prefer_source"),
                    actions: [
                        {
                            batchId: 11,
                            rowId: 1,
                            rowOrdinal: 1,
                            investmentId: 7,
                            action: "insert",
                            source: units,
                        },
                        {
                            batchId: 11,
                            rowId: 2,
                            rowOrdinal: 2,
                            investmentId: 7,
                            action: "insert",
                            source: {
                                ...units,
                                type: "dividend",
                                amount: "0.5000",
                                units: null,
                                price_per_unit: null,
                                income_recognition_role: "included_in_units",
                            },
                        },
                        {
                            batchId: 11,
                            rowId: 3,
                            rowOrdinal: 3,
                            action: "settled",
                        },
                    ],
                    summary: { insert: 2, settled: 1 },
                });
            }),
            http.post(`${api}/reconciliation/commit`, async ({ request }) => {
                commits.push((await request.json()) as Record<string, unknown>);
                const counts = {
                    imported: 2,
                    duplicates: 0,
                    adopted: 0,
                    errors: 0,
                };
                return ok({
                    ...counts,
                    batches: [{ ...counts, batch_id: 11 }],
                });
            }),
        );
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession accounts={[account(1, "Kinesis")]} />,
        );
        await selectAndStage(user, [kinesisStatement()]);
        await choosePolicy(user, "prefer_source");
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(await screen.findByText("New transactions")).toBeVisible();
        expect(screen.getByText("Already settled")).toBeVisible();
        await user.click(
            screen.getByText("Source evidence and proposed changes"),
        );
        expect(screen.getByText("Included in acquired units")).toBeVisible();
        expect(previews).toEqual([
            { batch_ids: [11], adopt_policy: "prefer_source" },
        ]);
        await user.click(
            screen.getByRole("button", { name: "Import reviewed history" }),
        );
        expect(
            await screen.findByText(
                /2 new records; 0 existing records reconciled/,
            ),
        ).toBeVisible();
        expect(commits).toEqual([
            { batch_ids: [11], adopt_policy: "prefer_source" },
        ]);
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
            await screen.findByLabelText(/Statements \(CSV/),
            statement(),
        );
        await pickOption(
            user,
            await screen.findByLabelText(
                "Other custody account (for asset transfers)",
            ),
            "Saxo",
        );
        await user.click(
            screen.getByRole("button", { name: "Prepare for review" }),
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
            transferOriginAccountId: asAccountId(2),
            transferDestinationAccountId: asAccountId(3),
        };
        await importPortfolioCSVWithProgress(
            statement(),
            config,
            config.format!,
            () => {},
            { isBrokerage: true, accountId: asAccountId(1) },
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
                ok({ ...plan(), ready: "yes" }),
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
            await screen.findByLabelText(/Statements \(CSV/),
            statement(),
        );
        expect(
            await screen.findByText(/broker account is ambiguous/),
        ).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Prepare for review" }),
        ).toBeDisabled();
        await user.upload(
            await screen.findByLabelText(/Statements \(CSV/),
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
            await screen.findByLabelText(/Statements \(CSV/),
            statement(),
        );
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Prepare for review" }),
            ).toBeEnabled(),
        );
        await user.click(
            screen.getByRole("button", { name: "Prepare for review" }),
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
                await chooseStatementPolicy(
                    user,
                    "wallet.csv",
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
            screen.getByRole("button", { name: "Prepare for review" }),
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
            await screen.findByLabelText(/Statements \(CSV/),
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
                            details: { reason: "stale_existing_transaction" },
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
        await user.upload(await screen.findByLabelText(/Statements \(CSV/), [
            statement("one.csv"),
            statement("two.csv"),
        ]);
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Prepare for review" }),
            ).toBeEnabled(),
        );
        await user.click(
            screen.getByRole("button", { name: "Prepare for review" }),
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
