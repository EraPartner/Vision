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
    reconciliationScope: "record_in_kind_income_only" as const,
};
const progress = {
    reconciliationScope: "record_in_kind_income_only",
    pending: 2,
    complete: false,
    deferredCounts: { gift: 1, asset_transfer: 1 },
};
function preview() {
    return {
        ...progress,
        batchIds: [11],
        adoptPolicy: "preserve_existing",
        batchPolicies: [],
        planFingerprint: "income-review",
        ready: true,
        selectedRowIds: [1],
        blockers: [],
        summary: { record_income: 1 },
        actions: [
            {
                batchId: 11,
                rowId: 1,
                rowOrdinal: 1,
                action: "record_income",
                incomeProof: {
                    kind: "paired_kinesis_income",
                    unitTransactionId: 99,
                },
                source: {
                    type: "dividend",
                    date: "2025-01-01",
                    amount: "5",
                    units: null,
                    price_per_unit: null,
                    fees: "0",
                    taxes: "0",
                    currency: "USD",
                    income_recognition_role: "included_in_units",
                },
            },
        ],
    };
}
function committed(recordedIncome = 1) {
    const counts = {
        imported: recordedIncome,
        recordedIncome,
        adopted: 0,
        repaired: 0,
        duplicates: 0,
        errors: 0,
    };
    return {
        ...progress,
        ...counts,
        selectedRowIds: [1],
        batches: [{ ...progress, ...counts, batch_id: 11 }],
    };
}

function repeatedPreview(action: "settled" | "duplicate", batchId = 11) {
    const original = preview();
    const { income_recognition_role: _role, ...source } =
        original.actions[0].source;
    return {
        ...original,
        batchIds: [batchId],
        planFingerprint: "paired-repeat",
        summary: {
            insert: 0,
            adopt: 0,
            record_income: 0,
            duplicate: 0,
            settled: 0,
            [action]: 1,
        },
        actions: [
            {
                batchId,
                rowId: 1,
                rowOrdinal: 1,
                action,
                existingTransactionId: 101,
                incomeProof: original.actions[0].incomeProof,
                ...(action === "duplicate" ? { investmentId: 7, source } : {}),
            },
        ],
    };
}

describe("paired Kinesis income scope", () => {
    it("sends preservation and the reviewed fingerprint, counts canonical income separately and retains pending source events", async () => {
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
        expect(requests).toEqual([
            {
                batch_ids: [11],
                adopt_policy: "preserve_existing",
                reconciliation_scope: "record_in_kind_income_only",
            },
            {
                batch_ids: [11],
                adopt_policy: "preserve_existing",
                reconciliation_scope: "record_in_kind_income_only",
                expected_plan_fingerprint: "income-review",
            },
        ]);
        expect(plan.actions[0].incomeProof?.unitTransactionId).toBe(99);
        expect(result).toMatchObject({
            imported: 1,
            recordedIncome: 1,
            adopted: 0,
            repaired: 0,
            pending: 2,
            complete: false,
        });
    });

    it("keeps a proved positive literal amount that rounds to zero at canonical precision", async () => {
        const plan = preview();
        plan.actions[0].source.amount = "0.0000";
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                () => ok(plan),
            ),
        );
        expect(
            (await previewPortfolioImportReconciliation(scope)).actions[0]
                .source?.amount,
        ).toBe("0.0000");
    });

    it("accepts a settled retry without claiming a newly recorded income row", async () => {
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/commit`,
                () => ok(committed(0)),
            ),
        );
        expect(
            await commitReviewedPortfolioImports({
                ...scope,
                expectedPlanFingerprint: "repeat",
            }),
        ).toMatchObject({ imported: 0, recordedIncome: 0, duplicates: 0 });
    });

    it.each([
        ["settled", 11],
        ["duplicate", 12],
    ] as const)(
        "verifies %s paired-income preview for source batch %s without claiming new income",
        async (action, batchId) => {
            const requests: unknown[] = [];
            server.use(
                http.post(
                    `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                    async ({ request }) => {
                        requests.push(await request.json());
                        return ok(repeatedPreview(action, batchId));
                    },
                ),
            );
            const plan = await previewPortfolioImportReconciliation({
                ...scope,
                batchIds: [batchId],
            });
            expect(requests).toEqual([
                {
                    batch_ids: [batchId],
                    adopt_policy: "preserve_existing",
                    reconciliation_scope: "record_in_kind_income_only",
                },
            ]);
            expect(plan.summary).toMatchObject({
                record_income: 0,
                [action]: 1,
            });
            expect(plan.actions[0]).toMatchObject({
                action,
                existingTransactionId: 101,
                incomeProof: {
                    kind: "paired_kinesis_income",
                    unitTransactionId: 99,
                },
            });
            expect(plan.actions[0].existing).toBeUndefined();
            if (action === "settled")
                expect(plan.actions[0].source).toBeUndefined();
            else
                expect(
                    plan.actions[0].source?.income_recognition_role,
                ).toBeUndefined();
            expect(plan).toMatchObject({
                selectedRowIds: [1],
                pending: 2,
                complete: false,
            });
        },
    );

    it.each([
        ["missing repeat proof", { incomeProof: undefined }],
        ["missing existing income", { existingTransactionId: undefined }],
        ["same income and unit identity", { existingTransactionId: 99 }],
        [
            "unknown pair kind",
            {
                incomeProof: {
                    kind: "ordinary_dividend",
                    unitTransactionId: 99,
                },
            },
        ],
        [
            "extra pair claims",
            {
                incomeProof: {
                    kind: "paired_kinesis_income",
                    unitTransactionId: 99,
                    guessed: true,
                },
            },
        ],
        ["unrelated source acquisition", { source: { type: "gift" } }],
        [
            "ordinary existing dividend",
            {
                existing: {
                    type: "dividend",
                    income_recognition_role: "standard",
                },
            },
        ],
        ["financial corrections", { corrections: ["amount"] }],
    ])("rejects repeat paired-income proof with %s", async (_name, changes) => {
        for (const action of ["settled", "duplicate"] as const) {
            const plan = repeatedPreview(action);
            server.use(
                http.post(
                    `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                    () =>
                        ok({
                            ...plan,
                            actions: [{ ...plan.actions[0], ...changes }],
                        }),
                ),
            );
            await expect(
                previewPortfolioImportReconciliation(scope),
            ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
        }
    });

    it("rejects paired-income proof in an unrelated attachment scope", async () => {
        const plan = repeatedPreview("settled");
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                () =>
                    ok({ ...plan, reconciliationScope: "adopt_existing_only" }),
            ),
        );
        await expect(
            previewPortfolioImportReconciliation({
                ...scope,
                reconciliationScope: "adopt_existing_only",
            }),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });

    it("rejects new and repeated income claiming the same acquired units", async () => {
        const plan = preview();
        const repeat = repeatedPreview("settled").actions[0];
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                () =>
                    ok({
                        ...plan,
                        selectedRowIds: [1, 2],
                        summary: { record_income: 1, settled: 1 },
                        actions: [
                            plan.actions[0],
                            { ...repeat, rowId: 2, rowOrdinal: 2 },
                        ],
                    }),
            ),
        );
        await expect(
            previewPortfolioImportReconciliation(scope),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });

    it("rejects one existing income record claimed by two different acquired-unit proofs", async () => {
        const plan = repeatedPreview("duplicate");
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                () =>
                    ok({
                        ...plan,
                        selectedRowIds: [1, 2],
                        summary: { record_income: 0, duplicate: 2 },
                        actions: [
                            plan.actions[0],
                            {
                                ...plan.actions[0],
                                rowId: 2,
                                rowOrdinal: 2,
                                incomeProof: {
                                    kind: "paired_kinesis_income",
                                    unitTransactionId: 100,
                                },
                            },
                        ],
                    }),
            ),
        );
        await expect(
            previewPortfolioImportReconciliation(scope),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });

    it.each([undefined, "prefer_source" as const])(
        "rejects incompatible income policy %s before any request",
        async (adoptPolicy) => {
            let calls = 0;
            server.use(
                http.post(
                    `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                    () => {
                        calls++;
                        return ok(preview());
                    },
                ),
            );
            await expect(
                previewPortfolioImportReconciliation({ ...scope, adoptPolicy }),
            ).rejects.toThrow("preserving proved existing units");
            expect(calls).toBe(0);
        },
    );

    it.each([
        ["source-preferred action", { policy: "prefer_source" }],
        ["missing pair proof", { incomeProof: undefined }],
        [
            "unrecognized pair proof",
            { incomeProof: { kind: "nearby_yield", unitTransactionId: 99 } },
        ],
        [
            "invalid acquisition ID",
            {
                incomeProof: {
                    kind: "paired_kinesis_income",
                    unitTransactionId: 0,
                },
            },
        ],
        [
            "extra proof fields",
            {
                incomeProof: {
                    kind: "paired_kinesis_income",
                    unitTransactionId: 99,
                    guessed: true,
                },
            },
        ],
        ["new acquisition action", { action: "adopt" }],
        ["financial correction", { corrections: ["amount"] }],
        ["existing correction target", { existingTransactionId: 99 }],
        [
            "new units",
            { source: { ...preview().actions[0].source, units: "1" } },
        ],
        [
            "acquisition price",
            { source: { ...preview().actions[0].source, price_per_unit: "5" } },
        ],
        [
            "invented source FX",
            { source: { ...preview().actions[0].source, fx_rate_to_eur: "1" } },
        ],
        [
            "ordinary income role",
            {
                source: {
                    ...preview().actions[0].source,
                    income_recognition_role: "standard",
                },
            },
        ],
        [
            "unknown role",
            {
                source: {
                    ...preview().actions[0].source,
                    income_recognition_role: "tax_free",
                },
            },
        ],
        [
            "absent amount",
            { source: { ...preview().actions[0].source, amount: null } },
        ],
        [
            "empty amount",
            { source: { ...preview().actions[0].source, amount: "" } },
        ],
        [
            "negative amount",
            { source: { ...preview().actions[0].source, amount: "-1" } },
        ],
        [
            "nonfinite amount",
            { source: { ...preview().actions[0].source, amount: "Infinity" } },
        ],
        [
            "non-dividend type",
            { source: { ...preview().actions[0].source, type: "gift" } },
        ],
        [
            "source fee",
            { source: { ...preview().actions[0].source, fees: "1" } },
        ],
        [
            "source tax",
            { source: { ...preview().actions[0].source, taxes: "1" } },
        ],
    ])("rejects an income preview with %s", async (_name, changes) => {
        const plan = preview();
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                () =>
                    ok({
                        ...plan,
                        actions: [{ ...plan.actions[0], ...changes }],
                    }),
            ),
        );
        await expect(
            previewPortfolioImportReconciliation(scope),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });

    it("rejects two literal income records claiming the same unit acquisition", async () => {
        const result = preview();
        result.actions.push({ ...result.actions[0], rowId: 2, rowOrdinal: 2 });
        result.selectedRowIds.push(2);
        result.summary.record_income = 2;
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                () => ok(result),
            ),
        );
        await expect(
            previewPortfolioImportReconciliation(scope),
        ).rejects.toThrow();
    });

    it.each([
        ["missing income subtotal", { recordedIncome: undefined }],
        ["different income subtotal", { recordedIncome: 0 }],
        ["new unit adoption", { adopted: 1 }],
        ["duplicate repair", { repaired: 1 }],
        [
            "missing batch income subtotal",
            {
                batches: [
                    { ...committed().batches[0], recordedIncome: undefined },
                ],
            },
        ],
        [
            "incorrect batch income subtotal",
            { batches: [{ ...committed().batches[0], recordedIncome: 0 }] },
        ],
        ["incorrect pending count", { pending: 0, complete: true }],
    ])("rejects an income commit with %s", async (_name, changes) => {
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/commit`,
                () => ok({ ...committed(), ...changes }),
            ),
        );
        await expect(
            commitReviewedPortfolioImports({
                ...scope,
                expectedPlanFingerprint: "review",
            }),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });
});
