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
const scope = { batchIds: [11], adoptPolicy: "prefer_source" as const };
const units = {
    type: "gift",
    date: "2025-01-01",
    units: "0.01",
    amount: "0.0000",
    price_per_unit: "0",
    fees: "0",
    taxes: "0",
    currency: "USD",
};
const income = {
    type: "dividend",
    date: "2025-01-01",
    units: null,
    amount: "0.5000",
    price_per_unit: null,
    fees: "0",
    taxes: "0",
    currency: "USD",
    income_recognition_role: "included_in_units",
};
function preview(unitAction = "insert", incomeAction = "record_income") {
    const existingUnit = unitAction !== "insert";
    return {
        batchIds: [11],
        adoptPolicy: "prefer_source",
        batchPolicies: [],
        planFingerprint: "full-pair",
        ready: true,
        blockers: [],
        summary: {
            [unitAction]: 1,
            [incomeAction]: unitAction === incomeAction ? 2 : 1,
        },
        actions: [
            {
                batchId: 11,
                rowId: 1,
                rowOrdinal: 1,
                investmentId: 7,
                action: unitAction,
                source: { ...units },
                ...(existingUnit ? { existingTransactionId: 99 } : {}),
                ...(unitAction === "adopt"
                    ? {
                          policy: "prefer_source",
                          existing: { ...units, amount: "0.01" },
                          corrections: ["amount"],
                      }
                    : {}),
            },
            {
                batchId: 11,
                rowId: 2,
                rowOrdinal: 2,
                investmentId: 7,
                action: incomeAction,
                incomeProof: {
                    kind: "paired_kinesis_income",
                    unitRowId: 1,
                    ...(existingUnit ? { unitTransactionId: 99 } : {}),
                },
                ...(incomeAction === "record_income"
                    ? { source: { ...income } }
                    : { existingTransactionId: 101 }),
            },
        ] as Array<Record<string, unknown>>,
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
function committed() {
    const counts = {
        imported: 4,
        recordedIncome: 1,
        recordedCash: 2,
        duplicates: 1,
        adopted: 1,
        repaired: 0,
        errors: 0,
    };
    return { ...counts, batches: [{ ...counts, batch_id: 11 }] };
}

describe("full history paired income contract", () => {
    it.each(["insert", "adopt", "duplicate", "settled"])(
        "binds new literal income to its selected %s Gift without adding another acquisition",
        async (unitAction) => {
            const requests: unknown[] = [];
            server.use(
                http.post(
                    `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                    async ({ request }) => {
                        requests.push(await request.json());
                        return ok(preview(unitAction));
                    },
                ),
            );
            const result = await previewPortfolioImportReconciliation(scope);
            expect(requests).toEqual([
                { batch_ids: [11], adopt_policy: "prefer_source" },
            ]);
            expect(result.actions[1].incomeProof).toEqual({
                kind: "paired_kinesis_income",
                unitRowId: 1,
                ...(unitAction !== "insert" ? { unitTransactionId: 99 } : {}),
            });
            expect(result.summary.record_income).toBe(1);
        },
    );
    it.each(["duplicate", "settled"])(
        "accepts proved full %s repeats with distinct canonical income and unit identities",
        async (action) => {
            const plan = preview(action, action);
            delete plan.actions[0].source;
            respond(plan);
            const result = await previewPortfolioImportReconciliation(scope);
            expect(result.actions[1].existingTransactionId).toBe(101);
            expect(result.actions[0].source).toBeUndefined();
            expect(result.actions[1].source).toBeUndefined();
            expect(result.summary[action]).toBe(2);
        },
    );
    it.each(["adopt", "duplicate", "settled"])(
        "rejects paired income when the selected %s Gift has nonzero source finances",
        async (unitAction) => {
            const value = preview(unitAction);
            value.actions[0].source = { ...units, fees: "1" };
            respond(value);
            await expect(
                previewPortfolioImportReconciliation(scope),
            ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
        },
    );
    it.each([
        [
            "missing unit row",
            {
                incomeProof: {
                    kind: "paired_kinesis_income",
                    unitTransactionId: 99,
                },
            },
        ],
        [
            "unselected unit row",
            { incomeProof: { kind: "paired_kinesis_income", unitRowId: 3 } },
        ],
        [
            "self pairing",
            { incomeProof: { kind: "paired_kinesis_income", unitRowId: 2 } },
        ],
        [
            "invented canonical ID before insert",
            {
                incomeProof: {
                    kind: "paired_kinesis_income",
                    unitRowId: 1,
                    unitTransactionId: 99,
                },
            },
        ],
        ["other routed batch", { batchId: 12 }],
        ["different investment", { investmentId: 8 }],
        ["missing investment binding", { investmentId: undefined }],
        [
            "different payment date",
            { source: { ...income, date: "2025-01-02" } },
        ],
        ["extra holdings", { source: { ...income, units: "1" } }],
        [
            "ordinary dividend role",
            { source: { ...income, income_recognition_role: "standard" } },
        ],
        ["financial correction", { corrections: ["amount"] }],
        ["missing proof", { incomeProof: undefined }],
    ])(
        "rejects a full paired-income action with %s",
        async (_name, changes) => {
            const plan = preview();
            plan.actions[1] = { ...plan.actions[1], ...changes };
            respond(plan);
            await expect(
                previewPortfolioImportReconciliation(scope),
            ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
        },
    );
    it.each([
        "missing existing unit",
        "wrong existing unit",
        "new unit on repeat",
        "non-gift pair",
        "positive new basis",
        "second claim",
    ])("rejects %s", async (kind) => {
        const plan = preview("duplicate", "duplicate");
        if (kind === "missing existing unit")
            plan.actions[1].incomeProof = {
                kind: "paired_kinesis_income",
                unitRowId: 1,
            };
        if (kind === "wrong existing unit")
            plan.actions[1].incomeProof = {
                kind: "paired_kinesis_income",
                unitRowId: 1,
                unitTransactionId: 98,
            };
        if (kind === "new unit on repeat")
            plan.actions[0] = {
                ...plan.actions[0],
                action: "insert",
                existingTransactionId: undefined,
            };
        if (kind === "non-gift pair")
            plan.actions[0].source = { ...units, type: "buy" };
        if (kind === "positive new basis") {
            Object.assign(plan, preview());
            plan.actions[0].source = { ...units, amount: "1" };
        }
        if (kind === "second claim")
            plan.actions.push({
                ...plan.actions[1],
                rowId: 3,
                existingTransactionId: 102,
            });
        respond(plan);
        await expect(
            previewPortfolioImportReconciliation(scope),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });
    it("keeps staged unit proof out of the unchanged narrow income scope", async () => {
        const plan = {
            ...preview("settled"),
            reconciliationScope: "record_in_kind_income_only",
            selectedRowIds: [2],
            pending: 0,
            complete: true,
            deferredCounts: {},
            adoptPolicy: "preserve_existing",
            actions: [preview("settled").actions[1]],
        };
        respond(plan);
        await expect(
            previewPortfolioImportReconciliation({
                ...scope,
                adoptPolicy: "preserve_existing",
                reconciliationScope: "record_in_kind_income_only",
            }),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });
    it("accepts additive full income and cash subtotals within all newly imported records", async () => {
        const requests: unknown[] = [];
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/commit`,
                async ({ request }) => {
                    requests.push(await request.json());
                    return ok(committed());
                },
            ),
        );
        expect(
            await commitReviewedPortfolioImports({
                ...scope,
                expectedPlanFingerprint: "full-pair",
            }),
        ).toMatchObject({ imported: 4, recordedIncome: 1, recordedCash: 2 });
        expect(requests).toEqual([
            {
                batch_ids: [11],
                adopt_policy: "prefer_source",
                expected_plan_fingerprint: "full-pair",
            },
        ]);
    });
    it.each([
        "missing batch subtotal",
        "missing aggregate subtotal",
        "different aggregate",
        "overlapping subtotals",
        "batch overflow",
    ])("rejects full commit with %s", async (kind) => {
        const value = committed();
        if (kind === "missing batch subtotal")
            delete (value.batches[0] as Partial<(typeof value.batches)[0]>)
                .recordedIncome;
        if (kind === "missing aggregate subtotal")
            delete (value as Partial<typeof value>).recordedCash;
        if (kind === "different aggregate") value.recordedIncome = 0;
        if (kind === "overlapping subtotals") {
            value.recordedIncome = 3;
            value.batches[0].recordedIncome = 3;
        }
        if (kind === "batch overflow") {
            value.imported = 2;
            value.batches[0].imported = 2;
        }
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/commit`,
                () => ok(value),
            ),
        );
        await expect(
            commitReviewedPortfolioImports({
                ...scope,
                expectedPlanFingerprint: "full-pair",
            }),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });
    it("keeps older full responses without additive subtotals compatible", async () => {
        const {
            recordedIncome: _income,
            recordedCash: _cash,
            ...old
        } = committed();
        const {
            recordedIncome: _batchIncome,
            recordedCash: _batchCash,
            ...batch
        } = old.batches[0];
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/commit`,
                () => ok({ ...old, batches: [batch] }),
            ),
        );
        expect(
            (
                await commitReviewedPortfolioImports({
                    ...scope,
                    expectedPlanFingerprint: "old",
                })
            ).imported,
        ).toBe(4);
    });
});
