// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ACCOUNT_LIST_ITEM_STUB, ok } from "@/test/msw/handlers";
import type { Account } from "@/types/api";
import {
    importPortfolioCSVWithProgress,
    previewPortfolioImportReconciliation,
    type PortfolioReconciliationMode,
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
function kinesisStatement(name = "kinesis.csv") {
    return new File(
        [
            "DateTime,HIN,Currency_Code,Transaction_Type,Transaction_ID,Order_ID,Starting_Balance,Closing_Balance",
        ],
        name,
        { type: "text/csv" },
    );
}
const nativeHeader =
    "Date,Type,Symbol,Units,Amount,Currency,Source_ID,Source_Account,Note,Receipt_JSON";
function nativeReceiptStatement(name = "native-receipts.csv") {
    const rows = [
        ["gift", "SYNTHETIC-SENDER-ONE"],
        ["gift", "SYNTHETIC-SENDER-TWO"],
        ["asset_fee", "SYNTHETIC-WALLET"],
        ["asset_transfer_witness", "SYNTHETIC-WALLET"],
    ].map(([type, identity], index) =>
        [
            "2025-01-01",
            type,
            "KAU",
            "1",
            type === "gift" ? "2" : "0",
            type === "gift" ? "USD" : "KAU",
            `SYNTHETIC-${index}`,
            identity,
            "source note",
            JSON.stringify({
                version: 1,
                asset: "KAU",
                transaction: { hash: "a".repeat(64) },
            }),
        ]
            .map((value) => `"${value.replaceAll('"', '""')}"`)
            .join(","),
    );
    return new File([[nativeHeader, ...rows].join("\n")], name, {
        type: "text/csv",
    });
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
type User = ReturnType<typeof userEvent.setup>;
/** Option labels of the reconciliation scope Select, by model value. */
const scopeLabels: Record<PortfolioReconciliationMode, string> = {
    full: "Full history",
    record_cash_only: "Record proven cash history",
    record_in_kind_income_only: "Record proven in-kind income",
    correct_existing_only: "Correct proven existing records",
    adopt_existing_only: "Attach proven source records",
};
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
const scopeField = () => screen.getByLabelText("Reconciliation scope");
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
function chooseScope(user: User, scope: PortfolioReconciliationMode) {
    return pickOption(user, scopeField(), scopeLabels[scope]);
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
/**
 * Opens a Select so its options exist in the DOM, runs `inspect` against
 * them and closes the list again without changing the value.
 */
async function withOptions<T>(
    user: User,
    trigger: HTMLElement,
    inspect: () => Promise<T> | T,
): Promise<T> {
    await user.click(trigger);
    await screen.findAllByRole("option");
    try {
        return await inspect();
    } finally {
        await user.keyboard("{Escape}");
        await waitFor(() =>
            expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
        );
    }
}
const expectOptionEnabled = (name: string) =>
    expect(screen.getByRole("option", { name })).not.toHaveAttribute(
        "aria-disabled",
    );
const expectOptionDisabled = (name: string) =>
    expect(screen.getByRole("option", { name })).toHaveAttribute(
        "aria-disabled",
        "true",
    );
/** Waits until the scope option `name` becomes selectable. */
function waitForScopeOption(user: User, name: string) {
    return withOptions(user, scopeField(), () =>
        waitFor(() => expectOptionEnabled(name)),
    );
}

async function chooseExistingBatch(user: User) {
    await user.click(
        await screen.findByText("Reconcile existing import history"),
    );
    await user.click(
        screen.getByRole("button", { name: "Load existing batches" }),
    );
    await pickOption(
        user,
        await screen.findByLabelText("Existing source batch"),
        /· Batch 4 ·/,
    );
    await user.click(
        screen.getByRole("button", { name: "Add selected history" }),
    );
}

function incomePlan(
    batchId = 11,
    action: "record_income" | "settled" | "duplicate" = "record_income",
) {
    const repeated = action !== "record_income";
    const base = plan(
        [batchId],
        "preserve_existing",
        repeated ? "income-repeat" : "income-review",
    );
    const source = {
        type: "dividend",
        date: "2025-01-01",
        amount: "5",
        units: null,
        price_per_unit: null,
        fees: "0",
        taxes: "0",
        currency: "USD",
    };
    return {
        ...base,
        reconciliationScope: "record_in_kind_income_only",
        pending: 2,
        complete: false,
        deferredCounts: { gift: 1, asset_transfer: 1 },
        selectedRowIds: [1],
        actions: [
            {
                batchId,
                rowId: 1,
                rowOrdinal: 1,
                action,
                incomeProof: {
                    kind: "paired_kinesis_income",
                    unitTransactionId: 99,
                },
                ...(repeated ? { existingTransactionId: 100 } : {}),
                ...(action === "record_income"
                    ? {
                          source: {
                              ...source,
                              income_recognition_role: "included_in_units",
                          },
                      }
                    : action === "duplicate"
                      ? { investmentId: 7, source }
                      : {}),
            },
        ],
        summary: { record_income: 0, duplicate: 0, settled: 0, [action]: 1 },
        batchProgress: [
            {
                batchId,
                pending: 2,
                complete: false,
                deferredCounts: { gift: 1, asset_transfer: 1 },
            },
        ],
    };
}

function cashPlan(
    action: "cash" | "duplicate" | "settled" = "cash",
    batchId = 11,
) {
    const base = plan([batchId], "preserve_existing", `cash-${action}`);
    return {
        ...base,
        reconciliationScope: "record_cash_only",
        pending: 2,
        complete: false,
        deferredCounts: { gift: 1, dividend: 1 },
        selectedRowIds: [1, 2, 3],
        summary: { [action]: 3 },
        actions: (
            ["trade_quote", "own_account_funding", "card_expense"] as const
        ).map((eventKind, index) => ({
            batchId,
            rowId: index + 1,
            rowOrdinal: index + 1,
            action,
            cashProof: {
                kind: "closed_kinesis_cash",
                groupKey: "a".repeat(64),
                eventKey: String(index + 1).repeat(64),
                fileHash: "b".repeat(64),
                eventKind,
                memberCount: 3,
                componentCount: index === 1 ? 2 : 1,
            },
            ...(action === "cash"
                ? {
                      ...(index === 1
                          ? {
                                cashFeeValues: {
                                    date: "2025-01-01",
                                    amount: "-0.5000",
                                    currency: "USD",
                                    accountId: 1,
                                    isTransfer: false,
                                    transferSource: "brokerage",
                                    transferPeerId: null,
                                },
                            }
                          : {}),
                      cashValues: {
                          date: "2025-01-01",
                          amount: index === 1 ? "-20.0000" : "-5.0000",
                          currency: "USD",
                          accountId: 1,
                          isTransfer: eventKind !== "card_expense",
                          transferSource: "brokerage",
                          transferPeerId: null,
                      },
                  }
                : {
                      existingTransactionId: index + 100,
                      ...(index === 1
                          ? { existingCashFeeTransactionId: 200 }
                          : {}),
                  }),
        })),
    };
}

describe("reviewed portfolio import sessions", () => {
    it.each([false, true])(
        "records a complete proved cash chain after source-bound confirmation and resumes the same scoped no-op review (retained=%s)",
        async (retained) => {
            const checkpoint = JSON.stringify({
                name: "original-reference.xml",
                placeholderBasisPolicy: "zero",
                applied: {
                    ...referenceResult([11]),
                    reconciliationScope: "correct_existing_only",
                    batch_ids: [11],
                    supplemental_batches: [],
                },
            });
            if (retained) {
                sessionStorage.setItem(
                    "vision.portfolio-import.latest-session.v1",
                    JSON.stringify([
                        {
                            id: "retained-cash",
                            name: "complete-kinesis.csv",
                            batchId: 11,
                            accountId: 1,
                            status: "staged",
                            detected: {
                                source: "kinesis",
                                sourceAccountIdentities: [],
                            },
                        },
                    ]),
                );
                sessionStorage.setItem(
                    "vision.portfolio-import.latest-reference.v1",
                    checkpoint,
                );
            }
            server.use(
                http.post(
                    `${api}/reconciliation/preview`,
                    async ({ request }) => {
                        previews.push(
                            (await request.json()) as Record<string, unknown>,
                        );
                        return ok(
                            cashPlan(commits.length ? "settled" : "cash"),
                        );
                    },
                ),
                http.post(
                    `${api}/reconciliation/commit`,
                    async ({ request }) => {
                        commits.push(
                            (await request.json()) as Record<string, unknown>,
                        );
                        const counts = {
                            imported: 4,
                            recordedCash: 4,
                            recordedIncome: 0,
                            adopted: 0,
                            repaired: 0,
                            duplicates: 0,
                            errors: 0,
                        };
                        const progress = {
                            reconciliationScope: "record_cash_only",
                            pending: 2,
                            complete: false,
                            deferredCounts: { gift: 1, dividend: 1 },
                        };
                        return ok({
                            ...counts,
                            ...progress,
                            selectedRowIds: [1, 2, 3],
                            batches: [{ ...counts, ...progress, batch_id: 11 }],
                        });
                    },
                ),
            );
            const user = userEvent.setup();
            const kinesisAccounts = [account(1, "Kinesis")];
            const first = renderWithApp(
                <PortfolioImportSession accounts={kinesisAccounts} />,
            );
            if (!retained)
                await user.upload(
                    await screen.findByLabelText("Statements (CSV or XLSX)"),
                    kinesisStatement(),
                );
            await waitForScopeOption(user, "Record proven cash history");
            await chooseScope(user, "record_cash_only");
            expect(
                screen.getByLabelText("Existing transaction facts"),
            ).toHaveTextContent(policyLabels.preserve_existing);
            expect(
                screen.queryByLabelText(
                    "Portfolio Performance reference (XML)",
                ),
            ).not.toBeInTheDocument();
            expect(
                screen.getByRole("button", { name: "Review reconciliation" }),
            ).toBeDisabled();
            const confirmation = screen.getByRole("checkbox", {
                name: /I confirm that this statement/,
            });
            expect(confirmation).not.toBeChecked();
            await user.click(confirmation);
            if (!retained) {
                await user.click(
                    screen.getByRole("button", { name: "Stage statements" }),
                );
                await waitFor(() =>
                    expect(
                        screen.getByRole("button", {
                            name: "Review reconciliation",
                        }),
                    ).toBeEnabled(),
                );
                expect(uploads[0]).toContain(
                    'name="yield_basis_policy"\r\n\r\nzero',
                );
            }
            await user.click(
                screen.getByRole("button", { name: "Review reconciliation" }),
            );
            expect(
                await screen.findByText(
                    "3 new cash source events; 4 new cash ledger records; 0 new holdings or income records. 2 source events remain pending.",
                ),
            ).toBeVisible();
            await user.click(
                screen.getByText("Source evidence and proposed changes"),
            );
            expect(screen.getByText("-20.0000 USD")).toBeVisible();
            expect(
                screen.getAllByText(
                    "Internal transfer; excluded from income and expenses",
                ),
            ).toHaveLength(2);
            expect(screen.getByText("Card expense")).toBeVisible();
            expect(
                screen.getByText(
                    "Separate withdrawal fee expense: -0.5000 USD",
                ),
            ).toBeVisible();
            await user.click(
                screen.getByRole("button", {
                    name: "Record reviewed cash history",
                }),
            );
            expect(
                await screen.findByText(
                    /4 cash records recorded; 0 duplicate source rows settled. 2 source events remain queued/,
                ),
            ).toBeVisible();
            expect(commits[0]).toEqual({
                batch_ids: [11],
                adopt_policy: "preserve_existing",
                reconciliation_scope: "record_cash_only",
                cash_funding_policy: "own_account_transfer",
                expected_plan_fingerprint: "cash-cash",
            });
            expect(references).toHaveLength(0);
            expect(
                sessionStorage.getItem(
                    "vision.portfolio-import.latest-reference.v1",
                ),
            ).toBe(retained ? checkpoint : null);
            first.unmount();
            renderWithApp(
                <PortfolioImportSession accounts={kinesisAccounts} />,
            );
            expect(
                screen.getByLabelText("Reconciliation scope"),
            ).toHaveTextContent(scopeLabels.record_cash_only);
            expect(
                screen.getByLabelText("Existing transaction facts"),
            ).toHaveTextContent(policyLabels.preserve_existing);
            expect(
                screen.getByRole("checkbox", {
                    name: /I confirm that this statement/,
                }),
            ).toBeChecked();
            expect(
                screen.queryByRole("button", {
                    name: "Record reviewed cash history",
                }),
            ).not.toBeInTheDocument();
            await user.click(
                screen.getByRole("button", { name: "Review reconciliation" }),
            );
            expect(
                await screen.findByText(
                    "0 new cash source events; 0 new cash ledger records; 0 new holdings or income records. 2 source events remain pending.",
                ),
            ).toBeVisible();
            const {
                expected_plan_fingerprint: _fingerprint,
                ...expectedScope
            } = commits[0];
            expect(previews[1]).toEqual(expectedScope);
        },
        15000,
    );
    it("shows explicit cash-only guidance for a source reconciliation blocker", async () => {
        server.use(
            http.post(`${api}/reconciliation/preview`, () =>
                ok({
                    ...plan([11]),
                    ready: false,
                    actions: [],
                    summary: {},
                    blockers: [
                        {
                            batchId: 11,
                            reason: "cash_reconciliation_required",
                            candidateTransactionIds: [],
                        },
                    ],
                }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession accounts={[account(1, "Kinesis")]} />,
        );
        await user.upload(
            await screen.findByLabelText("Statements (CSV or XLSX)"),
            kinesisStatement(),
        );
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Stage statements" }),
            ).toBeEnabled(),
        );
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
        expect(
            await screen.findByText(
                /Record new Kinesis cash through the cash-only scope and confirm own-account funding before importing\./,
            ),
        ).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Import reviewed history" }),
        ).toBeDisabled();
        expect(commits).toHaveLength(0);
    }, 15000);
    it("clears cash confirmation and review when source routing changes, and rejects a stale persisted intent", async () => {
        const kinesisAccounts = [
            account(1, "Kinesis"),
            account(2, "Kinesis", "Second broker"),
        ];
        const user = userEvent.setup();
        const first = renderWithApp(
            <PortfolioImportSession accounts={kinesisAccounts} />,
        );
        await user.upload(
            await screen.findByLabelText("Statements (CSV or XLSX)"),
            kinesisStatement(),
        );
        await waitForScopeOption(user, "Record proven cash history");
        await chooseScope(user, "record_cash_only");
        await user.click(screen.getByRole("button", { name: "Change" }));
        const broker = screen.getByRole("combobox", { name: "Broker" });
        await user.click(broker);
        await user.click(
            await screen.findByRole("option", { name: "Kinesis" }),
        );
        await user.click(
            screen.getByRole("checkbox", {
                name: /I confirm that this statement/,
            }),
        );
        await user.click(
            screen.getByRole("button", { name: "Stage statements" }),
        );
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Review reconciliation" }),
            ).toBeEnabled(),
        );
        const settings = sessionStorage.getItem(
            "vision.portfolio-import.latest-review-settings.v1",
        )!;
        await user.click(screen.getByRole("combobox", { name: "Broker" }));
        await user.click(
            await screen.findByRole("option", { name: "Second broker" }),
        );
        expect(
            screen.getByRole("checkbox", {
                name: /I confirm that this statement/,
            }),
        ).not.toBeChecked();
        expect(
            screen.getByRole("button", { name: "Stage statements" }),
        ).toBeDisabled();
        first.unmount();
        sessionStorage.setItem(
            "vision.portfolio-import.latest-review-settings.v1",
            settings,
        );
        const queued = JSON.parse(
            sessionStorage.getItem(
                "vision.portfolio-import.latest-session.v1",
            ) ?? "[]",
        );
        sessionStorage.setItem(
            "vision.portfolio-import.latest-session.v1",
            JSON.stringify([
                {
                    ...(queued[0] ?? {
                        id: "changed",
                        name: "changed.csv",
                        batchId: 11,
                        status: "staged",
                        detected: {
                            source: "kinesis",
                            sourceAccountIdentities: [],
                        },
                    }),
                    accountId: 2,
                },
            ]),
        );
        renderWithApp(<PortfolioImportSession accounts={kinesisAccounts} />);
        expect(screen.getByLabelText("Reconciliation scope")).toHaveTextContent(
            scopeLabels.full,
        );
        expect(
            screen.getByLabelText("Existing transaction facts"),
        ).toHaveTextContent(policyLabels.auto);
    });

    it.each([false, true])(
        "records literal paired income without acquisitions or XML and retains pending source on resume (retained=%s)",
        async (retained) => {
            const checkpoint = JSON.stringify({
                name: "original-reference.xml",
                placeholderBasisPolicy: "zero",
                applied: {
                    ...referenceResult([11]),
                    reconciliationScope: "correct_existing_only",
                    batch_ids: [11],
                    supplemental_batches: [],
                },
            });
            if (retained) {
                sessionStorage.setItem(
                    "vision.portfolio-import.latest-session.v1",
                    JSON.stringify([
                        {
                            id: "retained-income",
                            name: "complete-kinesis.csv",
                            batchId: 11,
                            accountId: 1,
                            status: "staged",
                            detected: {
                                source: "kinesis",
                                sourceAccountIdentities: [],
                            },
                        },
                    ]),
                );
                sessionStorage.setItem(
                    "vision.portfolio-import.latest-reference.v1",
                    checkpoint,
                );
            }
            server.use(
                http.post(
                    `${api}/reconciliation/preview`,
                    async ({ request }) => {
                        previews.push(
                            (await request.json()) as Record<string, unknown>,
                        );
                        return ok(
                            incomePlan(
                                11,
                                commits.length > 0
                                    ? "settled"
                                    : "record_income",
                            ),
                        );
                    },
                ),
                http.post(
                    `${api}/reconciliation/commit`,
                    async ({ request }) => {
                        commits.push(
                            (await request.json()) as Record<string, unknown>,
                        );
                        const counts = {
                            imported: commits.length === 1 ? 1 : 0,
                            recordedIncome: commits.length === 1 ? 1 : 0,
                            adopted: 0,
                            repaired: 0,
                            duplicates: 0,
                            errors: 0,
                        };
                        const progress = {
                            reconciliationScope: "record_in_kind_income_only",
                            pending: 2,
                            complete: false,
                            deferredCounts: { gift: 1, asset_transfer: 1 },
                        };
                        return ok({
                            ...counts,
                            ...progress,
                            selectedRowIds: [1],
                            batches: [{ batch_id: 11, ...counts, ...progress }],
                        });
                    },
                ),
            );
            const user = userEvent.setup();
            const kinesisAccounts = [account(1, "Kinesis")];
            const first = renderWithApp(
                <PortfolioImportSession accounts={kinesisAccounts} />,
            );
            if (!retained)
                await user.upload(
                    await screen.findByLabelText("Statements (CSV or XLSX)"),
                    kinesisStatement(),
                );
            await waitForScopeOption(user, "Record proven in-kind income");
            await chooseScope(user, "record_in_kind_income_only");
            expect(
                screen.getByLabelText("Existing transaction facts"),
            ).toHaveTextContent(policyLabels.preserve_existing);
            expect(
                screen.getByLabelText("Existing transaction facts"),
            ).toBeDisabled();
            expect(
                screen.queryByLabelText(
                    "Portfolio Performance reference (XML)",
                ),
            ).not.toBeInTheDocument();
            expect(
                screen.getByText(
                    /original statement and acquisition receipts provide the evidence/,
                ),
            ).toBeVisible();
            if (!retained) {
                await user.click(
                    screen.getByRole("button", { name: "Stage statements" }),
                );
                await waitFor(() =>
                    expect(
                        screen.getByRole("button", {
                            name: "Review reconciliation",
                        }),
                    ).toBeEnabled(),
                );
                expect(uploads[0]).toContain(
                    'name="yield_basis_policy"\r\n\r\nzero',
                );
            }
            await user.click(
                screen.getByRole("button", { name: "Review reconciliation" }),
            );
            expect(
                await screen.findByText(
                    "0 new acquisitions; 1 income records to record; 2 events remain pending.",
                ),
            ).toBeVisible();
            expect(screen.getByText("Gift events: 1")).toBeVisible();
            await user.click(
                screen.getByText("Source evidence and proposed changes"),
            );
            const roleRow = screen
                .getAllByRole("row")
                .find((row) =>
                    within(row).queryByText("Income accounting role"),
                )!;
            expect(
                within(roleRow).getByText("Included in acquired units"),
            ).toBeVisible();
            const amountRow = screen
                .getAllByRole("row")
                .find((row) => within(row).queryByText("Principal"))!;
            expect(within(amountRow).getByText("5")).toBeVisible();
            await user.click(
                screen.getByRole("button", { name: "Record reviewed income" }),
            );
            expect(
                await screen.findByText(
                    /Recorded 1 proven income records; 0 new acquisitions; 2 events remain pending/,
                ),
            ).toBeVisible();
            expect(commits[0]).toEqual({
                batch_ids: [11],
                adopt_policy: "preserve_existing",
                reconciliation_scope: "record_in_kind_income_only",
                expected_plan_fingerprint: "income-review",
            });
            expect(
                JSON.parse(
                    sessionStorage.getItem(
                        "vision.portfolio-import.latest-session.v1",
                    )!,
                )[0],
            ).toMatchObject({ batchId: 11, status: "staged" });
            expect(
                sessionStorage.getItem(
                    "vision.portfolio-import.latest-reference.v1",
                ),
            ).toBe(retained ? checkpoint : null);
            first.unmount();
            renderWithApp(
                <PortfolioImportSession accounts={kinesisAccounts} />,
            );
            expect(
                screen.getByLabelText("Reconciliation scope"),
            ).toHaveTextContent(scopeLabels.record_in_kind_income_only);
            expect(
                screen.getByLabelText("Existing transaction facts"),
            ).toHaveTextContent(policyLabels.preserve_existing);
            await user.click(
                screen.getByRole("button", { name: "Review reconciliation" }),
            );
            expect(
                await screen.findByText(
                    "0 new acquisitions; 0 income records to record; 2 events remain pending.",
                ),
            ).toBeVisible();
            await user.click(
                screen.getByRole("button", { name: "Record reviewed income" }),
            );
            expect(
                await screen.findByText(
                    /Recorded 0 proven income records; 0 new acquisitions; 2 events remain pending/,
                ),
            ).toBeVisible();
            expect(commits[1]).toEqual({
                ...previews[1],
                expected_plan_fingerprint: "income-repeat",
            });
            expect(uploads).toHaveLength(retained ? 0 : 1);
            expect(references).toHaveLength(0);
            expect(
                sessionStorage.getItem(
                    "vision.portfolio-import.latest-reference.v1",
                ),
            ).toBe(retained ? checkpoint : null);
        },
    );

    it("settles a freshly staged paired-income duplicate without recording income again", async () => {
        server.use(
            http.post(`${api}/reconciliation/preview`, async ({ request }) => {
                previews.push(
                    (await request.json()) as Record<string, unknown>,
                );
                return ok(incomePlan(11, "duplicate"));
            }),
            http.post(`${api}/reconciliation/commit`, async ({ request }) => {
                commits.push((await request.json()) as Record<string, unknown>);
                const progress = {
                    reconciliationScope: "record_in_kind_income_only",
                    pending: 2,
                    complete: false,
                    deferredCounts: { gift: 1, asset_transfer: 1 },
                };
                const counts = {
                    imported: 0,
                    recordedIncome: 0,
                    adopted: 0,
                    repaired: 0,
                    duplicates: 1,
                    errors: 0,
                };
                return ok({
                    ...progress,
                    ...counts,
                    selectedRowIds: [1],
                    batches: [{ batch_id: 11, ...progress, ...counts }],
                });
            }),
        );
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession accounts={[account(1, "Kinesis")]} />,
        );
        await user.upload(
            await screen.findByLabelText("Statements (CSV or XLSX)"),
            kinesisStatement("fresh-repeat.csv"),
        );
        await waitForScopeOption(user, "Record proven in-kind income");
        await chooseScope(user, "record_in_kind_income_only");
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
        expect(
            await screen.findByText(
                "0 new acquisitions; 0 income records to record; 2 events remain pending.",
            ),
        ).toBeVisible();
        expect(
            screen.queryByText(/response could not be verified/i),
        ).not.toBeInTheDocument();
        await user.click(
            screen.getByRole("button", { name: "Record reviewed income" }),
        );
        expect(
            await screen.findByText(
                /Recorded 0 proven income records; 0 new acquisitions; 2 events remain pending/,
            ),
        ).toBeVisible();
        expect(commits).toEqual([
            {
                batch_ids: [11],
                adopt_policy: "preserve_existing",
                reconciliation_scope: "record_in_kind_income_only",
                expected_plan_fingerprint: "income-repeat",
            },
        ]);
        expect(
            JSON.parse(
                sessionStorage.getItem(
                    "vision.portfolio-import.latest-session.v1",
                )!,
            )[0],
        ).toMatchObject({ batchId: 11, status: "staged" });
        expect(uploads).toHaveLength(1);
        expect(references).toHaveLength(0);
    });

    it("blocks income recording for filtered, source-preferred or mixed sources without changing the selected scope", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession
                accounts={[account(1, "Kinesis"), account(2, "Nexo")]}
            />,
        );
        await user.upload(
            screen.getByLabelText("Statements (CSV or XLSX)"),
            kinesisStatement(),
        );
        const option = "Record proven in-kind income";
        await waitForScopeOption(user, option);
        await user.type(screen.getByLabelText("Assets to include"), "TOKEN");
        await withOptions(user, scopeField(), () =>
            expectOptionDisabled(option),
        );
        await user.clear(screen.getByLabelText("Assets to include"));
        await chooseStatementPolicy(user, "kinesis.csv", "prefer_source");
        await withOptions(user, scopeField(), () =>
            expectOptionDisabled(option),
        );
        await chooseStatementPolicy(user, "kinesis.csv", "");
        await chooseScope(user, "record_in_kind_income_only");
        expect(screen.getByLabelText("Assets to include")).toBeDisabled();
        await user.upload(
            screen.getByLabelText("Statements (CSV or XLSX)"),
            statement(),
        );
        expect(
            await screen.findByText(
                /In-kind income requires only complete Kinesis statements/,
            ),
        ).toBeVisible();
        expect(screen.getByLabelText("Reconciliation scope")).toHaveTextContent(
            scopeLabels.record_in_kind_income_only,
        );
        expect(
            screen.getByRole("button", { name: "Stage statements" }),
        ).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Review reconciliation" }),
        ).toBeDisabled();
        expect(previews).toHaveLength(0);
    });

    it("rejects filtered or contrary-policy correction sources and keeps correction mode blocked after an incompatible file is added", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession
                accounts={[account(1, "Kinesis"), account(2, "Nexo")]}
            />,
        );
        await user.upload(
            screen.getByLabelText("Statements (CSV or XLSX)"),
            kinesisStatement(),
        );
        const option = "Correct proven existing records";
        await waitForScopeOption(user, option);
        await user.type(screen.getByLabelText("Assets to include"), "KAG");
        await withOptions(user, scopeField(), () =>
            expectOptionDisabled(option),
        );
        await user.clear(screen.getByLabelText("Assets to include"));
        await chooseStatementPolicy(user, "kinesis.csv", "preserve_existing");
        await withOptions(user, scopeField(), () =>
            expectOptionDisabled(option),
        );
        await chooseStatementPolicy(user, "kinesis.csv", "");
        await chooseScope(user, "correct_existing_only");
        expect(screen.getByLabelText("Assets to include")).toBeDisabled();
        await user.upload(
            screen.getByLabelText("Statements (CSV or XLSX)"),
            statement(),
        );
        await screen.findByText(
            /Existing corrections require only complete Kinesis statements/,
        );
        expect(screen.getByLabelText("Reconciliation scope")).toHaveTextContent(
            scopeLabels.correct_existing_only,
        );
        expect(
            screen.getByRole("button", { name: "Stage statements" }),
        ).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Review reconciliation" }),
        ).toBeDisabled();
        expect(previews).toHaveLength(0);
        expect(commits).toHaveLength(0);
    });

    it.each(["full", "adopt_existing_only"] as const)(
        "stages a CSV-only Kinesis session in %s scope with the appropriate yield policy before review",
        async (scope) => {
            let upload = "";
            server.use(
                http.post(`${api}/csv/stream`, async ({ request }) => {
                    upload = await request.text();
                    return staged(11);
                }),
                http.post(
                    `${api}/reconciliation/preview`,
                    async ({ request }) => {
                        const body = (await request.json()) as Record<
                            string,
                            unknown
                        >;
                        previews.push(body);
                        const base = plan([11], "preserve_existing");
                        if (
                            body.reconciliation_scope !== "adopt_existing_only"
                        ) {
                            return ok(base);
                        }
                        const knownZero = upload.includes(
                            'name="yield_basis_policy"\r\n\r\nzero',
                        );
                        const financialFacts = {
                            date: "2025-01-01",
                            units: "9.97",
                            amount: "0",
                            price: "0",
                            fees: "0",
                            taxes: "0",
                            currency: "EUR",
                        };
                        const pending = knownZero ? 2 : 3;
                        const deferredCounts = {
                            gift: knownZero ? 1 : 2,
                            dividend: 1,
                        };
                        return ok({
                            ...base,
                            ready: knownZero,
                            actions: knownZero
                                ? [
                                      {
                                          ...base.actions[0],
                                          policy: "preserve_existing",
                                          source: financialFacts,
                                          existing: financialFacts,
                                          corrections: [],
                                      },
                                  ]
                                : [],
                            blockers: knownZero
                                ? []
                                : [{ reason: "yield_basis_unknown" }],
                            summary: knownZero ? { adopt: 1 } : {},
                            reconciliationScope: "adopt_existing_only",
                            pending,
                            complete: false,
                            deferredCounts,
                            selectedRowIds: knownZero ? [1] : [],
                            batchProgress: [
                                {
                                    batchId: 11,
                                    pending,
                                    complete: false,
                                    deferredCounts,
                                },
                            ],
                        });
                    },
                ),
            );
            const user = userEvent.setup();
            renderWithApp(
                <PortfolioImportSession accounts={[account(1, "Kinesis")]} />,
            );
            await user.upload(
                await screen.findByLabelText("Statements (CSV or XLSX)"),
                kinesisStatement(),
            );
            await waitForScopeOption(user, "Attach proven source records");
            expect(
                screen.getByLabelText("Reconciliation scope"),
            ).toHaveTextContent(scopeLabels.full);
            if (scope === "adopt_existing_only") {
                await chooseScope(user, scope);
            } else {
                await choosePolicy(user, "preserve_existing");
            }
            expect(
                screen.getByText(
                    scope === "adopt_existing_only"
                        ? /Choose this scope before staging complete Kinesis statements/
                        : /Review all selected history together/,
                ),
            ).toBeVisible();
            await user.click(
                screen.getByRole("button", { name: "Stage statements" }),
            );
            await waitFor(() =>
                expect(
                    screen.getByRole("button", {
                        name: "Review reconciliation",
                    }),
                ).toBeEnabled(),
            );
            expect(upload).toContain(
                'name="portfolio_format"\r\n\r\nkinesis_transaction_history',
            );
            expect(upload).toContain('name="account_id"\r\n\r\n1');
            expect(upload).toContain('name="file"; filename=');
            expect(upload).toContain('name="yield_basis_policy"\r\n\r\nzero');
            expect(references).toHaveLength(0);
            await user.click(
                screen.getByRole("button", { name: "Review reconciliation" }),
            );
            expect(
                await screen.findByRole("button", {
                    name:
                        scope === "adopt_existing_only"
                            ? "Attach reviewed source records"
                            : "Import reviewed history",
                }),
            ).toBeEnabled();
            expect(previews).toEqual([
                {
                    batch_ids: [11],
                    adopt_policy: "preserve_existing",
                    ...(scope === "adopt_existing_only"
                        ? { reconciliation_scope: scope }
                        : {}),
                },
            ]);
            if (scope === "adopt_existing_only") {
                expect(
                    screen.getByText(
                        "0 new transactions; 1 existing records to attach; 2 events remain pending.",
                    ),
                ).toBeVisible();
                expect(screen.getByText("Gift events: 1")).toBeVisible();
                expect(screen.getByText("Income events: 1")).toBeVisible();
            }
            expect(commits).toHaveLength(0);
        },
    );

    it("attaches only the proven Kinesis subset without XML, retains partial sources and requires a fresh review", async () => {
        const metadata = {
            reconciliationScope: "adopt_existing_only",
            pending: 3,
            complete: false,
            deferredCounts: { dividend: 2, gift: 1 },
        };
        server.use(
            http.post(`${api}/reconciliation/preview`, async ({ request }) => {
                const body = (await request.json()) as Record<string, unknown>;
                previews.push(body);
                const base = plan(
                    [11, 12],
                    "preserve_existing",
                    `bounded-${previews.length}`,
                );
                return ok({
                    ...base,
                    ...metadata,
                    selectedRowIds: [1],
                    summary: { adopt: 1 },
                });
            }),
            http.post(`${api}/reconciliation/commit`, async ({ request }) => {
                commits.push((await request.json()) as Record<string, unknown>);
                const counts = {
                    imported: 0,
                    duplicates: 1,
                    adopted: 1,
                    repaired: 0,
                    errors: 0,
                };
                return ok({
                    ...metadata,
                    ...counts,
                    selectedRowIds: [1],
                    batches: [
                        { ...metadata, ...counts, batch_id: 11 },
                        {
                            ...metadata,
                            imported: 0,
                            duplicates: 0,
                            adopted: 0,
                            repaired: 0,
                            errors: 0,
                            batch_id: 12,
                            pending: 0,
                            complete: true,
                            deferredCounts: {},
                        },
                    ],
                });
            }),
        );
        const user = userEvent.setup();
        const kinesisAccounts = [account(1, "Kinesis")];
        const first = renderWithApp(
            <PortfolioImportSession accounts={kinesisAccounts} />,
        );
        await user.upload(
            await screen.findByLabelText("Statements (CSV or XLSX)"),
            [kinesisStatement(), kinesisStatement("older.csv")],
        );
        await waitForScopeOption(user, "Attach proven source records");
        await chooseScope(user, "adopt_existing_only");
        expect(
            screen.getByLabelText("Existing transaction facts"),
        ).toHaveTextContent(policyLabels.preserve_existing);
        expect(
            screen.getByLabelText("Existing transaction facts"),
        ).toBeDisabled();
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
        expect(
            await screen.findByText(
                "0 new transactions; 1 existing records to attach; 3 events remain pending.",
            ),
        ).toBeVisible();
        expect(screen.getByText("Income events: 2")).toBeVisible();
        expect(screen.getByText("Gift events: 1")).toBeVisible();
        expect(previews[0]).toEqual({
            batch_ids: [11, 12],
            adopt_policy: "preserve_existing",
            reconciliation_scope: "adopt_existing_only",
        });
        await user.click(
            screen.getByRole("button", {
                name: "Attach reviewed source records",
            }),
        );
        expect(
            await screen.findByText(
                /3 events remain pending. Statements stay queued/,
            ),
        ).toBeVisible();
        expect(commits[0]).toEqual({
            ...previews[0],
            expected_plan_fingerprint: "bounded-1",
        });
        const retained = JSON.parse(
            sessionStorage.getItem(
                "vision.portfolio-import.latest-session.v1",
            )!,
        );
        expect(
            retained.map((item: { batchId: number; status: string }) => [
                item.batchId,
                item.status,
            ]),
        ).toEqual([
            [11, "staged"],
            [12, "staged"],
        ]);
        expect(
            screen.queryByRole("button", {
                name: "Attach reviewed source records",
            }),
        ).not.toBeInTheDocument();
        first.unmount();
        renderWithApp(<PortfolioImportSession accounts={kinesisAccounts} />);
        await chooseScope(user, "adopt_existing_only");
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await screen.findByRole("button", {
            name: "Attach reviewed source records",
        });
        expect(previews[1]).toEqual(previews[0]);
        expect(uploads).toHaveLength(2);
        expect(references).toHaveLength(0);
        expect(commits).toHaveLength(1);
        expect(
            sessionStorage.getItem(
                "vision.portfolio-import.latest-reference.v1",
            ),
        ).toBeNull();
    });

    it("invalidates a full review when choosing attachment scope and never broadens it after an incompatible file is added", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession
                accounts={[account(1, "Kinesis"), account(2, "Nexo")]}
            />,
        );
        await selectAndStage(user, [kinesisStatement()]);
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        expect(
            await screen.findByRole("button", {
                name: "Import reviewed history",
            }),
        ).toBeEnabled();
        await chooseScope(user, "adopt_existing_only");
        expect(
            screen.queryByRole("button", { name: "Import reviewed history" }),
        ).not.toBeInTheDocument();
        await user.upload(
            screen.getByLabelText("Statements (CSV or XLSX)"),
            statement(),
        );
        await screen.findByText(
            /Source attachment requires only complete Kinesis statements/,
        );
        expect(screen.getByLabelText("Reconciliation scope")).toHaveTextContent(
            scopeLabels.adopt_existing_only,
        );
        expect(
            screen.getByRole("button", { name: "Review reconciliation" }),
        ).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Stage statements" }),
        ).toBeDisabled();
        expect(commits).toHaveLength(0);
    });

    it("requires complete Kinesis statements without source-preferred policies for attachment mode", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession
                accounts={[account(1, "Kinesis"), account(2, "Nexo")]}
            />,
        );
        await user.upload(
            screen.getByLabelText("Statements (CSV or XLSX)"),
            kinesisStatement(),
        );
        const option = "Attach proven source records";
        await waitForScopeOption(user, option);
        const assetFilter = screen.getByLabelText("Assets to include");
        await user.type(assetFilter, "KAG");
        await withOptions(user, scopeField(), () =>
            expectOptionDisabled(option),
        );
        await user.clear(assetFilter);
        await withOptions(user, scopeField(), () =>
            expectOptionEnabled(option),
        );
        await chooseStatementPolicy(user, "kinesis.csv", "prefer_source");
        await withOptions(user, scopeField(), () =>
            expectOptionDisabled(option),
        );
        await chooseStatementPolicy(user, "kinesis.csv", "preserve_existing");
        await withOptions(user, scopeField(), () =>
            expectOptionEnabled(option),
        );
        await chooseScope(user, "adopt_existing_only");
        expect(assetFilter).toBeDisabled();
        await withOptions(user, statementPolicyField("kinesis.csv"), () =>
            expectOptionDisabled("Use detailed source facts"),
        );
        expect(previews).toHaveLength(0);
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

    it("joint-stages the complete Kinesis statement and native receipts with zero yield policy and generic source identities", async () => {
        const forms: string[] = [];
        const browserForms: FormData[] = [];
        const delegate = globalThis.fetch;
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation((input, init) => {
                if (init?.body instanceof FormData)
                    browserForms.push(init.body);
                return delegate(input, init);
            });
        onTestFinished(() => fetchSpy.mockRestore());
        const field = (body: string, name: string) =>
            body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
        server.use(
            http.post(`${api}/csv/stream`, async ({ request }) => {
                forms.push(await request.text());
                return staged(10 + forms.length);
            }),
        );
        const user = userEvent.setup();
        const native = nativeReceiptStatement();
        const currentAccounts = [
            account(1, "Kinesis"),
            account(2, "Wallet", "CoolWallet"),
        ];
        const view = renderWithApp(
            <PortfolioImportSession accounts={currentAccounts} />,
        );
        await selectAndStage(user, [kinesisStatement(), native]);
        expect(forms).toHaveLength(2);
        expect(field(forms[0], "portfolio_format")).toBe(
            "kinesis_transaction_history",
        );
        expect(field(forms[0], "yield_basis_policy")).toBe("zero");
        expect(field(forms[0], "account_id")).toBe("1");
        const wallet = forms[1];
        expect(field(wallet, "adapter_name")).toBe("portfolio_generic");
        expect(field(wallet, "portfolio_format")).toBeUndefined();
        expect(field(wallet, "account_id")).toBe("2");
        expect(field(wallet, "is_brokerage")).toBe("true");
        expect(field(wallet, "date_format")).toBe("%Y-%m-%d");
        expect(field(wallet, "number_format")).toBe("decimal_dot");
        expect(field(wallet, "source_id_column")).toBe("Source_ID");
        expect(field(wallet, "source_account_column")).toBe("Source_Account");
        expect(field(wallet, "yield_basis_policy")).toBeUndefined();
        expect(field(wallet, "included_symbols")).toBeUndefined();
        // jsdom File and Node's fetch serializer use different Blob brands.
        // Inspect the browser body actually handed to fetch; node API tests
        // separately assert byte-exact serialization on the Node transport.
        expect(browserForms).toHaveLength(2);
        const sourceFile = browserForms[1].get("file") as File;
        expect(sourceFile.name).toBe(native.name);
        const sourceText = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsText(sourceFile);
        });
        expect(new TextEncoder().encode(sourceText).length).toBe(native.size);
        expect(sourceText).toContain(nativeHeader);
        expect(sourceText).toContain('""version"":1');
        expect(screen.getByLabelText("Reconciliation scope")).toHaveTextContent(
            scopeLabels.full,
        );
        expect(
            screen.getByText(/Review all selected history together/),
        ).toBeVisible();
        expect(
            screen.queryByText(/new acquisitions and income remain pending/),
        ).not.toBeInTheDocument();
        await choosePolicy(user, "prefer_source");
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await waitFor(() =>
            expect(previews).toEqual([
                { batch_ids: [11, 12], adopt_policy: "prefer_source" },
            ]),
        );
        expect(commits).toHaveLength(0);
        expect(
            JSON.parse(
                sessionStorage.getItem(
                    "vision.portfolio-import.latest-session.v1",
                )!,
            )[1],
        ).toMatchObject({
            batchId: 12,
            accountId: 2,
            detected: {
                source: "native_receipts",
                sourceAccountIdentities: [
                    "SYNTHETIC-SENDER-ONE",
                    "SYNTHETIC-SENDER-TWO",
                    "SYNTHETIC-WALLET",
                ],
            },
        });
        view.unmount();
        renderWithApp(<PortfolioImportSession accounts={currentAccounts} />);
        expect(await screen.findByText("native-receipts.csv")).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Review reconciliation" }),
        ).toBeEnabled();
        expect(forms).toHaveLength(2);
    });

    it("keeps ambiguous native wallet routing explicit and rejects unrelated generic CSV files", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession
                accounts={[
                    account(1, "Wallet", "CoolWallet"),
                    account(2, "Wallet", "CoolWallet"),
                ]}
            />,
        );
        await user.upload(
            await screen.findByLabelText("Statements (CSV or XLSX)"),
            nativeReceiptStatement(),
        );
        expect(
            await screen.findByText(/broker account is ambiguous/),
        ).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Stage statements" }),
        ).toBeDisabled();
        await user.upload(
            screen.getByLabelText("Statements (CSV or XLSX)"),
            new File(
                [
                    "Date,Type,Symbol,Units,Amount,Currency\n2025-01-01,gift,KAU,1,2,USD",
                ],
                "ordinary-generic.csv",
            ),
        );
        expect(
            await screen.findByText(/no supported automatic adapter/),
        ).toBeVisible();
        expect(uploads).toHaveLength(0);
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

    it("reviews full paired income beside its one new Gift and already-owned cash without XML or another acquisition", async () => {
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
                    ...plan([11], "prefer_source", "full-income-review"),
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
                            action: "record_income",
                            incomeProof: {
                                kind: "paired_kinesis_income",
                                unitRowId: 1,
                            },
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
                            existingTransactionId: 101,
                            cashProof: {
                                kind: "closed_kinesis_cash",
                                groupKey: "a".repeat(64),
                                eventKey: "b".repeat(64),
                                fileHash: "c".repeat(64),
                                eventKind: "card_expense",
                                memberCount: 1,
                                componentCount: 1,
                            },
                        },
                    ],
                    summary: { insert: 1, record_income: 1, settled: 1 },
                });
            }),
            http.post(`${api}/reconciliation/commit`, async ({ request }) => {
                commits.push((await request.json()) as Record<string, unknown>);
                const counts = {
                    imported: 2,
                    recordedIncome: 1,
                    recordedCash: 0,
                    duplicates: 0,
                    adopted: 0,
                    repaired: 0,
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
        expect(await screen.findByText("Record paired income")).toBeVisible();
        expect(previews).toEqual([
            { batch_ids: [11], adopt_policy: "prefer_source" },
        ]);
        expect(document.querySelector('input[accept=".xml"]')).toBeNull();
        await user.click(
            screen.getByRole("button", { name: "Import reviewed history" }),
        );
        expect(
            await screen.findByText(
                /2 new records; 0 existing records reconciled/,
            ),
        ).toBeVisible();
        expect(commits).toEqual([
            {
                batch_ids: [11],
                adopt_policy: "prefer_source",
                expected_plan_fingerprint: "full-income-review",
            },
        ]);
        expect(references).toHaveLength(0);
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
        await pickOption(
            user,
            await screen.findByLabelText(
                "Other custody account (for asset transfers)",
            ),
            "Saxo",
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
    it("loads legacy queued broker proof without offering XML in any scope or sending a reference request", async () => {
        sessionStorage.setItem(
            "vision.portfolio-import.latest-session.v1",
            JSON.stringify([
                {
                    id: "legacy-31",
                    name: "original.csv",
                    kind: "reference",
                    originalBatchId: 4,
                    accountId: 1,
                    batchId: 31,
                    status: "staged",
                    rows: 2,
                    detected: {
                        source: "kinesis",
                        sourceAccountIdentities: [],
                    },
                },
            ]),
        );
        sessionStorage.setItem(
            "vision.portfolio-import.latest-reference.v1",
            JSON.stringify({ name: "old.xml", applied: { batch_ids: [99] } }),
        );
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession accounts={[account(1, "Kinesis")]} />,
        );
        expect(await screen.findByText("original.csv")).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await waitFor(() => expect(previews).toHaveLength(1));
        expect(previews[0]).toEqual({ batch_ids: [31] });
        expect(uploads).toHaveLength(0);
        for (const scope of [
            "adopt_existing_only",
            "correct_existing_only",
            "record_in_kind_income_only",
            "record_cash_only",
            "full",
        ] as const) {
            // Scopes the legacy proof cannot enter stay disabled; the native
            // select skipped those silently, the Radix list keeps them visible.
            const selectable = await withOptions(
                user,
                scopeField(),
                () =>
                    !screen
                        .getByRole("option", { name: scopeLabels[scope] })
                        .hasAttribute("aria-disabled"),
            );
            if (selectable) await chooseScope(user, scope);
            expect(document.querySelector('input[accept=".xml"]')).toBeNull();
            expect(
                screen.queryByText("Optional Portfolio Performance reference"),
            ).not.toBeInTheDocument();
            expect(
                screen.queryByLabelText(
                    "Portfolio Performance reference (XML)",
                ),
            ).not.toBeInTheDocument();
        }
        expect(references).toHaveLength(0);
        expect(
            JSON.parse(
                sessionStorage.getItem(
                    "vision.portfolio-import.latest-session.v1",
                )!,
            )[0].batchId,
        ).toBe(31);
    });

    it("reviews an explicitly selected retained broker batch without uploading XML or source bytes", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioImportSession accounts={[account(3, "IBKR")]} />,
        );
        await chooseExistingBatch(user);
        await user.click(
            screen.getByRole("button", { name: "Review reconciliation" }),
        );
        await waitFor(() => expect(previews).toHaveLength(1));
        expect(previews[0]).toEqual({ batch_ids: [4] });
        expect(uploads).toHaveLength(0);
        expect(references).toHaveLength(0);
        expect(document.querySelector('input[accept=".xml"]')).toBeNull();
    });
});
