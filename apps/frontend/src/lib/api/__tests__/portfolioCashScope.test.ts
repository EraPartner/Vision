// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";
import {
    previewPortfolioImportReconciliation,
    commitReviewedPortfolioImports,
} from "@/lib/api/portfolioImports";

afterEach(() => server.resetHandlers());
const scope = {
    batchIds: [11],
    adoptPolicy: "preserve_existing" as const,
    reconciliationScope: "record_cash_only" as const,
    cashFundingPolicy: "own_account_transfer" as const,
};
const progress = {
    reconciliationScope: "record_cash_only",
    pending: 2,
    complete: false,
    deferredCounts: { gift: 1, dividend: 1 },
};
function preview(
    action: "cash" | "duplicate" | "settled" = "cash",
    batchId = 11,
) {
    return {
        ...progress,
        batchIds: [batchId],
        adoptPolicy: "preserve_existing",
        batchPolicies: [],
        planFingerprint: "cash-review",
        ready: true,
        selectedRowIds: [1, 2, 3],
        blockers: [],
        summary: { [action]: 3 },
        actions: (
            ["trade_quote", "own_account_funding", "card_expense"] as const
        ).map((eventKind, index) => ({
            batchId,
            rowId: index + 1,
            rowOrdinal: index + 1,
            action,
            existingTransactionId: undefined as number | undefined,
            cashValues: undefined as
                | {
                      date: string;
                      amount: string;
                      currency: string;
                      accountId: number;
                      isTransfer: boolean;
                      transferSource: string;
                      transferPeerId: null;
                  }
                | undefined,
            cashProof: {
                kind: "closed_kinesis_cash",
                groupKey: "a".repeat(64),
                eventKey: String(index + 1).repeat(64),
                eventKind,
                fileHash: "b".repeat(64),
                memberCount: 3,
                componentCount: 1,
            },
            ...(action === "cash"
                ? {
                      cashValues: {
                          date: "2025-01-01",
                          amount: index === 1 ? "20.0000" : "-5.0000",
                          currency: "USD",
                          accountId: 7,
                          isTransfer: eventKind !== "card_expense",
                          transferSource: "brokerage",
                          transferPeerId: null,
                      },
                  }
                : { existingTransactionId: index + 100 }),
        })),
    };
}
function committed(recordedCash = 3, duplicates = 0, batchId = 11) {
    const counts = {
        imported: recordedCash,
        recordedCash,
        recordedIncome: 0,
        adopted: 0,
        repaired: 0,
        duplicates,
        errors: 0,
    };
    return {
        ...progress,
        ...counts,
        selectedRowIds: [1, 2, 3],
        batches: [{ ...progress, ...counts, batch_id: batchId }],
    };
}
function respond(value: unknown) {
    server.use(
        http.post(
            `${API_BASE}/api/portfolio/import/reconciliation/preview`,
            () => ok(value),
        ),
    );
}

describe("complete Kinesis cash-only scope", () => {
    it("sends confirmed source funding and the reviewed fingerprint, with distinct cash counts and no portfolio drain", async () => {
        const requests: unknown[] = [];
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                async ({ request }) => {
                    requests.push(await request.json());
                    return ok(preview());
                },
            ),
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/commit`,
                async ({ request }) => {
                    requests.push(await request.json());
                    return ok(committed());
                },
            ),
        );
        const plan = await previewPortfolioImportReconciliation(scope);
        const result = await commitReviewedPortfolioImports({
            ...scope,
            expectedPlanFingerprint: plan.planFingerprint,
        });
        const body = {
            batch_ids: [11],
            adopt_policy: "preserve_existing",
            reconciliation_scope: "record_cash_only",
            cash_funding_policy: "own_account_transfer",
        };
        expect(requests).toEqual([
            body,
            { ...body, expected_plan_fingerprint: "cash-review" },
        ]);
        expect(plan.actions.map((a) => a.cashValues?.isTransfer)).toEqual([
            true,
            true,
            false,
        ]);
        expect(result).toMatchObject({
            imported: 3,
            recordedCash: 3,
            recordedIncome: 0,
            adopted: 0,
            repaired: 0,
            pending: 2,
            complete: false,
        });
    });
    it("records a withdrawal fee as a separate expense component and validates repeated component identities", async () => {
        const value = preview();
        Object.assign(value.actions[1].cashProof, { componentCount: 2 });
        Object.assign(value.actions[1], {
            cashValues: {
                ...value.actions[0].cashValues,
                amount: "-20.0000",
                isTransfer: true,
            },
            cashFeeValues: {
                ...value.actions[0].cashValues,
                amount: "-0.5000",
                isTransfer: false,
            },
        });
        respond(value);
        expect(
            (await previewPortfolioImportReconciliation(scope)).summary.cash,
        ).toBe(3);
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/commit`,
                () => ok(committed(4)),
            ),
        );
        expect(
            await commitReviewedPortfolioImports({
                ...scope,
                expectedPlanFingerprint: "cash-review",
            }),
        ).toMatchObject({ recordedCash: 4, imported: 4 });
        const repeated = preview("settled");
        Object.assign(repeated.actions[1].cashProof, { componentCount: 2 });
        Object.assign(repeated.actions[1], {
            existingCashFeeTransactionId: 200,
        });
        respond(repeated);
        expect(
            (await previewPortfolioImportReconciliation(scope)).actions[1]
                .existingCashFeeTransactionId,
        ).toBe(200);
        Object.assign(repeated.actions[1], {
            existingCashFeeTransactionId: 100,
        });
        respond(repeated);
        await expect(
            previewPortfolioImportReconciliation(scope),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });
    it.each([
        "missing fee",
        "fee marked transfer",
        "fee currency mismatch",
        "fee account mismatch",
        "positive fee",
        "fee on card",
        "fee on single component",
        "missing repeated fee identity",
    ])("rejects %s", async (kind) => {
        const value = preview(
            kind === "missing repeated fee identity" ? "settled" : "cash",
        );
        const target = value.actions[1];
        Object.assign(target.cashProof, { componentCount: 2 });
        if (kind !== "missing repeated fee identity")
            Object.assign(target, {
                cashValues: {
                    ...value.actions[0].cashValues,
                    amount: "-20.0000",
                    isTransfer: true,
                },
                cashFeeValues: {
                    ...value.actions[0].cashValues,
                    amount: "-0.5000",
                    isTransfer: false,
                },
            });
        if (kind === "missing fee")
            Object.assign(target, { cashFeeValues: undefined });
        if (kind === "fee marked transfer")
            Object.assign(target, {
                cashFeeValues: {
                    ...value.actions[0].cashValues,
                    amount: "-0.5",
                    isTransfer: true,
                },
            });
        if (kind === "fee currency mismatch")
            Object.assign(target, {
                cashFeeValues: {
                    ...value.actions[0].cashValues,
                    amount: "-0.5",
                    isTransfer: false,
                    currency: "EUR",
                },
            });
        if (kind === "fee account mismatch")
            Object.assign(target, {
                cashFeeValues: {
                    ...value.actions[0].cashValues,
                    amount: "-0.5",
                    isTransfer: false,
                    accountId: 8,
                },
            });
        if (kind === "positive fee")
            Object.assign(target, {
                cashFeeValues: {
                    ...value.actions[0].cashValues,
                    amount: "0.5",
                    isTransfer: false,
                },
            });
        if (kind === "fee on card") target.cashProof.eventKind = "card_expense";
        if (kind === "fee on single component")
            target.cashProof.componentCount = 1;
        respond(value);
        await expect(
            previewPortfolioImportReconciliation(scope),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });
    it.each(["settled", "duplicate"] as const)(
        "accepts proved %s repeats without another cash record",
        async (action) => {
            const batchId = action === "duplicate" ? 12 : 11;
            respond(preview(action, batchId));
            server.use(
                http.post(
                    `${API_BASE}/api/portfolio/import/reconciliation/commit`,
                    () =>
                        ok(
                            committed(
                                0,
                                action === "duplicate" ? 3 : 0,
                                batchId,
                            ),
                        ),
                ),
            );
            expect(
                (
                    await previewPortfolioImportReconciliation({
                        ...scope,
                        batchIds: [batchId],
                    })
                ).actions,
            ).toHaveLength(3);
            expect(
                await commitReviewedPortfolioImports({
                    ...scope,
                    batchIds: [batchId],
                    expectedPlanFingerprint: "cash-review",
                }),
            ).toMatchObject({ imported: 0, recordedCash: 0 });
        },
    );
    it.each([
        ["missing confirmation", { cashFundingPolicy: undefined }],
        ["wrong policy", { adoptPolicy: "prefer_source" }],
        [
            "contrary batch policy",
            { batchPolicies: [{ batchId: 11, adoptPolicy: "prefer_source" }] },
        ],
        ["confirmation in full scope", { reconciliationScope: "full" }],
    ])("rejects %s before dispatch", async (_name, change) => {
        await expect(
            previewPortfolioImportReconciliation({
                ...scope,
                ...change,
            } as typeof scope),
        ).rejects.toThrow();
    });
    it.each([
        ["missing proof", { cashProof: undefined }],
        ["missing values", { cashValues: undefined }],
        ["portfolio action", { action: "insert" }],
        ["new action with existing identity", { existingTransactionId: 99 }],
        [
            "unrelated income proof",
            {
                incomeProof: {
                    kind: "paired_kinesis_income",
                    unitTransactionId: 99,
                },
            },
        ],
        [
            "unrelated portfolio values",
            { source: { type: "gift", amount: "0" } },
        ],
        ["unrelated correction", { corrections: ["fees"] }],
        [
            "unrelated custody",
            {
                transfer: {
                    date: "2025-01-01",
                    units: "1",
                    feeUnits: "0",
                    receivedUnits: "1",
                    sourceAccountId: 1,
                    destinationAccountId: 2,
                },
            },
        ],
    ])("rejects %s in a closed cash chain", async (_name, change) => {
        const value = preview();
        Object.assign(value.actions[0], change);
        respond(value);
        await expect(
            previewPortfolioImportReconciliation(scope),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });
    it.each([
        ["cash source without brokerage origin", { transferSource: "manual" }],
        ["invented peer", { transferPeerId: 9 }],
        ["trade counted as expense", { isTransfer: false }],
        ["zero movement", { amount: "0" }],
        ["nondecimal amount", { amount: "NaN" }],
        ["invalid date", { date: "2025-02-30" }],
        ["invalid account", { accountId: 0 }],
    ])("rejects %s", async (_name, change) => {
        const value = preview();
        Object.assign(value.actions[0].cashValues!, change);
        respond(value);
        await expect(
            previewPortfolioImportReconciliation(scope),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });
    it("rejects card expense marked internal and card inflow", async () => {
        for (const change of [{ isTransfer: true }, { amount: "5" }]) {
            const value = preview();
            Object.assign(value.actions[2].cashValues!, change);
            respond(value);
            await expect(
                previewPortfolioImportReconciliation(scope),
            ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
        }
    });
    it.each([
        "partial",
        "different hash",
        "reused event",
        "different count",
        "duplicate existing identity",
        "unproved repeat",
    ])("rejects %s group", async (kind) => {
        const value = preview(
            kind.includes("identity") || kind.includes("repeat")
                ? "settled"
                : "cash",
        );
        if (kind === "partial") {
            value.actions.pop();
            value.selectedRowIds.pop();
            value.summary = { cash: 2 };
        }
        if (kind === "different hash")
            value.actions[1].cashProof.fileHash = "c".repeat(64);
        if (kind === "reused event")
            value.actions[1].cashProof.eventKey =
                value.actions[0].cashProof.eventKey;
        if (kind === "different count")
            value.actions[1].cashProof.memberCount = 2;
        if (kind === "duplicate existing identity")
            value.actions[1].existingTransactionId =
                value.actions[0].existingTransactionId;
        if (kind === "unproved repeat")
            Object.assign(value.actions[1], { cashProof: undefined });
        respond(value);
        await expect(
            previewPortfolioImportReconciliation(scope),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });
    it("rejects cash proof in an unrelated full preview", async () => {
        respond({
            ...preview(),
            reconciliationScope: undefined,
            adoptPolicy: null,
        });
        await expect(
            previewPortfolioImportReconciliation({ batchIds: [11] }),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });
    it.each(["duplicate", "settled"] as const)(
        "accepts only the already-owned complete %s cash chain in full history",
        async (action) => {
            const {
                reconciliationScope: _scope,
                pending: _pending,
                complete: _complete,
                deferredCounts: _deferred,
                selectedRowIds: _selected,
                ...full
            } = preview(action);
            respond(full);
            const plan = await previewPortfolioImportReconciliation({
                batchIds: [11],
                adoptPolicy: "preserve_existing",
            });
            expect(plan.summary[action]).toBe(3);
            expect(plan.actions.every((item) => item.cashProof)).toBe(true);
            const changed = structuredClone(full);
            changed.actions[0].existingTransactionId = undefined;
            respond(changed);
            await expect(
                previewPortfolioImportReconciliation({
                    batchIds: [11],
                    adoptPolicy: "preserve_existing",
                }),
            ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
        },
    );
    it.each([
        ["missing cash subtotal", { recordedCash: undefined }],
        ["different cash subtotal", { recordedCash: 2 }],
        ["portfolio adoption", { adopted: 1 }],
        ["income drain", { recordedIncome: 1 }],
        ["repair drain", { repaired: 1 }],
        [
            "missing batch cash subtotal",
            {
                batches: [
                    { ...committed().batches[0], recordedCash: undefined },
                ],
            },
        ],
        [
            "per-batch income drain",
            { batches: [{ ...committed().batches[0], recordedIncome: 1 }] },
        ],
    ])("rejects %s in commit", async (_name, change) => {
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/commit`,
                () => ok({ ...committed(), ...change }),
            ),
        );
        await expect(
            commitReviewedPortfolioImports({
                ...scope,
                expectedPlanFingerprint: "cash-review",
            }),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });
});
