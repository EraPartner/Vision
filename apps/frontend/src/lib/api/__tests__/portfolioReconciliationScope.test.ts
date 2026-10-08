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
    reconciliationScope: "adopt_existing_only" as const,
};
function metadata() {
    return {
        reconciliationScope: "adopt_existing_only",
        pending: 2,
        complete: false,
        deferredCounts: { insert: 2 },
    };
}
function preview() {
    return {
        ...metadata(),
        selectedRowIds: [1],
        batchIds: [11],
        adoptPolicy: "preserve_existing",
        batchPolicies: [],
        planFingerprint: "bounded-review",
        ready: true,
        actions: [
            {
                batchId: 11,
                rowId: 1,
                rowOrdinal: 1,
                action: "adopt",
                policy: "preserve_existing",
            },
        ],
        blockers: [],
        summary: { adopt: 1 },
    };
}
function committed() {
    const counts = {
        imported: 0,
        duplicates: 1,
        adopted: 1,
        repaired: 0,
        errors: 0,
    };
    return {
        ...metadata(),
        ...counts,
        selectedRowIds: [1],
        batches: [{ batch_id: 11, ...metadata(), ...counts }],
    };
}
describe("bounded portfolio reconciliation API", () => {
    it("sends the derived scope and reviewed fingerprint while preserving partial metadata", async () => {
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
                reconciliation_scope: "adopt_existing_only",
            },
            {
                batch_ids: [11],
                adopt_policy: "preserve_existing",
                reconciliation_scope: "adopt_existing_only",
                expected_plan_fingerprint: "bounded-review",
            },
        ]);
        expect(result).toMatchObject({
            imported: 0,
            adopted: 1,
            pending: 2,
            complete: false,
            selectedRowIds: [1],
        });
    });

    it("rejects narrow requests with automatic or conflicting policies before sending them", async () => {
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
            previewPortfolioImportReconciliation({
                ...scope,
                adoptPolicy: undefined,
            }),
        ).rejects.toThrow("preserving existing facts");
        await expect(
            previewPortfolioImportReconciliation({
                ...scope,
                batchPolicies: [{ batchId: 11, adoptPolicy: "prefer_source" }],
            }),
        ).rejects.toThrow("preserving existing facts");
        expect(calls).toBe(0);
    });

    it.each([
        ["wrong scope", { reconciliationScope: "full" }],
        ["missing pending metadata", { pending: undefined }],
        ["inconsistent completion", { complete: true }],
        ["inconsistent deferred counts", { deferredCounts: { insert: 1 } }],
        ["wrong selected rows", { selectedRowIds: [2] }],
        ["duplicate selected rows", { selectedRowIds: [1, 1] }],
        ["unselected summary count", { summary: { adopt: 1, insert: 2 } }],
        [
            "insert action",
            {
                actions: [
                    { batchId: 11, rowId: 1, rowOrdinal: 1, action: "insert" },
                ],
                summary: { insert: 1 },
            },
        ],
        [
            "conflicting action policy",
            {
                actions: [
                    {
                        batchId: 11,
                        rowId: 1,
                        rowOrdinal: 1,
                        action: "adopt",
                        policy: "prefer_source",
                    },
                ],
            },
        ],
    ])("rejects a preview with %s", async (_name, changes) => {
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                () => ok({ ...preview(), ...changes }),
            ),
        );
        await expect(
            previewPortfolioImportReconciliation(scope),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });

    it.each([
        [
            "new transaction",
            {
                imported: 1,
                batches: [{ ...committed().batches[0], imported: 1 }],
            },
        ],
        [
            "repair",
            {
                repaired: 1,
                duplicates: 2,
                batches: [
                    { ...committed().batches[0], repaired: 1, duplicates: 2 },
                ],
            },
        ],
        ["missing selected rows", { selectedRowIds: undefined }],
        [
            "missing batch lifecycle",
            { batches: [{ ...committed().batches[0], complete: undefined }] },
        ],
        [
            "inconsistent batch pending",
            {
                batches: [
                    {
                        ...committed().batches[0],
                        pending: 1,
                        deferredCounts: { insert: 1 },
                    },
                ],
            },
        ],
    ])("rejects a narrow commit reporting %s", async (_name, changes) => {
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/commit`,
                () => ok({ ...committed(), ...changes }),
            ),
        );
        await expect(
            commitReviewedPortfolioImports({
                ...scope,
                expectedPlanFingerprint: "bounded-review",
            }),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });

    it("accepts an already settled retry with zero newly settled duplicate rows", async () => {
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/commit`,
                () =>
                    ok({
                        ...committed(),
                        duplicates: 0,
                        adopted: 0,
                        batches: [
                            {
                                ...committed().batches[0],
                                duplicates: 0,
                                adopted: 0,
                            },
                        ],
                    }),
            ),
        );
        await expect(
            commitReviewedPortfolioImports({
                ...scope,
                expectedPlanFingerprint: "bounded-review",
            }),
        ).resolves.toMatchObject({
            selectedRowIds: [1],
            duplicates: 0,
            pending: 2,
        });
    });
});

const correctionScope = {
    batchIds: [11],
    adoptPolicy: "prefer_source" as const,
    reconciliationScope: "correct_existing_only" as const,
};
function correctionPreview() {
    const base = preview();
    return {
        ...base,
        reconciliationScope: "correct_existing_only",
        adoptPolicy: "prefer_source",
        actions: [
            {
                ...base.actions[0],
                policy: "prefer_source",
                existingTransactionId: 99,
                source: {
                    date: "2025-01-01",
                    units: "1",
                    amount: "5",
                    currency: "USD",
                    fx_rate_to_eur: null,
                },
                existing: {
                    date: "2025-01-01",
                    units: "1",
                    amount: "5",
                    currency: "EUR",
                    fx_rate_to_eur: "1",
                },
                corrections: ["currency", "fx_rate_to_eur"],
            },
        ],
    };
}
function correctionCommit() {
    const base = committed();
    return {
        ...base,
        reconciliationScope: "correct_existing_only",
        batches: base.batches.map((batch) => ({
            ...batch,
            reconciliationScope: "correct_existing_only",
        })),
    };
}
function groupedDatePreview() {
    const base = correctionPreview();
    return {
        ...base,
        selectedRowIds: [1, 2],
        summary: { adopt: 2 },
        actions: ["2025-01-01", "2025-02-01"].map((date, index) => {
            const existing = {
                type: "gift",
                date,
                units: String(index + 1),
                amount: "0",
                price_per_unit: "0",
                fees: "0",
                taxes: "0",
                currency: "USD",
                fx_rate_to_eur: null,
                dividend_amount_convention: null,
            };
            return {
                ...base.actions[0],
                rowId: index + 1,
                rowOrdinal: index + 1,
                existingTransactionId: 99 + index,
                existing,
                source: { ...existing, date: "2025-03-01" },
                corrections: ["date"],
                dateProof: {
                    kind: "closed_kinesis_yield_group",
                    groupKey: "a".repeat(64),
                    recordedDate: date,
                    paymentDate: "2025-03-01",
                    memberCount: 3,
                },
            };
        }),
    };
}

describe("bounded existing financial corrections API", () => {
    it("accepts only typed grouped date corrections with unchanged zero financials and retains anchor context without counting it as a correction", async () => {
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                () => ok(groupedDatePreview()),
            ),
        );
        const result =
            await previewPortfolioImportReconciliation(correctionScope);
        expect(result.summary).toEqual({ adopt: 2 });
        expect(result.selectedRowIds).toEqual([1, 2]);
        expect(result.actions.map((action) => action.dateProof)).toEqual([
            expect.objectContaining({
                recordedDate: "2025-01-01",
                paymentDate: "2025-03-01",
                memberCount: 3,
            }),
            expect.objectContaining({
                recordedDate: "2025-02-01",
                paymentDate: "2025-03-01",
                memberCount: 3,
            }),
        ]);
        expect(result.pending).toBe(2);
    });

    it.each([
        ["missing typed proof", { dateProof: undefined }],
        [
            "unrecognized proof kind",
            {
                dateProof: {
                    ...groupedDatePreview().actions[0].dateProof,
                    kind: "nearby_date",
                },
            },
        ],
        [
            "invalid group key",
            {
                dateProof: {
                    ...groupedDatePreview().actions[0].dateProof,
                    groupKey: "unbound",
                },
            },
        ],
        [
            "invalid calendar date",
            {
                dateProof: {
                    ...groupedDatePreview().actions[0].dateProof,
                    recordedDate: "2025-02-30",
                },
            },
        ],
        [
            "different recorded date",
            {
                dateProof: {
                    ...groupedDatePreview().actions[0].dateProof,
                    recordedDate: "2025-01-02",
                },
            },
        ],
        [
            "different payment date",
            {
                dateProof: {
                    ...groupedDatePreview().actions[0].dateProof,
                    paymentDate: "2025-03-02",
                },
            },
        ],
        [
            "extra proof fields",
            {
                dateProof: {
                    ...groupedDatePreview().actions[0].dateProof,
                    allowed: true,
                },
            },
        ],
        ["financial change with date", { corrections: ["date", "fees"] }],
        [
            "different source units",
            {
                source: {
                    ...groupedDatePreview().actions[0].source,
                    units: "9",
                },
            },
        ],
        [
            "changed basis",
            {
                source: {
                    ...groupedDatePreview().actions[0].source,
                    amount: "1",
                },
            },
        ],
        [
            "different group member counts",
            {
                dateProof: {
                    ...groupedDatePreview().actions[0].dateProof,
                    memberCount: 4,
                },
            },
        ],
        [
            "fewer members than distinct corrections",
            {
                dateProof: {
                    ...groupedDatePreview().actions[0].dateProof,
                    memberCount: 1,
                },
            },
        ],
        ["duplicate canonical target", { existingTransactionId: 100 }],
    ])(
        "rejects grouped correction evidence with %s",
        async (_name, changes) => {
            const response = groupedDatePreview();
            server.use(
                http.post(
                    `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                    () =>
                        ok({
                            ...response,
                            actions: [
                                { ...response.actions[0], ...changes },
                                response.actions[1],
                            ],
                        }),
                ),
            );
            await expect(
                previewPortfolioImportReconciliation(correctionScope),
            ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
        },
    );

    it("rejects an undeclared date change in an ordinary financial correction", async () => {
        const response = correctionPreview();
        response.actions[0].source.date = "2025-02-01";
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                () => ok(response),
            ),
        );
        await expect(
            previewPortfolioImportReconciliation(correctionScope),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });

    it("sends correction policy and reviewed fingerprint while retaining partial progress", async () => {
        const requests: unknown[] = [];
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                async ({ request }) => {
                    requests.push(await request.json());
                    return ok(correctionPreview());
                },
            ),
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/commit`,
                async ({ request }) => {
                    requests.push(await request.json());
                    return ok(correctionCommit());
                },
            ),
        );
        const plan =
            await previewPortfolioImportReconciliation(correctionScope);
        const result = await commitReviewedPortfolioImports({
            ...correctionScope,
            expectedPlanFingerprint: plan.planFingerprint,
        });
        expect(requests).toEqual([
            {
                batch_ids: [11],
                adopt_policy: "prefer_source",
                reconciliation_scope: "correct_existing_only",
            },
            {
                batch_ids: [11],
                adopt_policy: "prefer_source",
                reconciliation_scope: "correct_existing_only",
                expected_plan_fingerprint: "bounded-review",
            },
        ]);
        expect(result).toMatchObject({
            imported: 0,
            repaired: 0,
            adopted: 1,
            pending: 2,
            complete: false,
        });
    });

    it.each([
        ["automatic policy", { adoptPolicy: undefined }],
        ["preserving policy", { adoptPolicy: "preserve_existing" as const }],
        [
            "contrary batch policy",
            {
                batchPolicies: [
                    { batchId: 11, adoptPolicy: "preserve_existing" as const },
                ],
            },
        ],
    ])(
        "rejects correction requests with %s before any upload",
        async (_name, changes) => {
            let calls = 0;
            server.use(
                http.post(
                    `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                    () => {
                        calls++;
                        return ok(correctionPreview());
                    },
                ),
            );
            await expect(
                previewPortfolioImportReconciliation({
                    ...correctionScope,
                    ...changes,
                }),
            ).rejects.toThrow("explicit source facts");
            expect(calls).toBe(0);
        },
    );

    it.each(["date", "units", "type", "note", "dividend_amount_convention"])(
        "rejects correction previews that propose changing %s",
        async (field) => {
            const response = correctionPreview();
            response.actions[0].corrections = [field];
            server.use(
                http.post(
                    `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                    () => ok(response),
                ),
            );
            await expect(
                previewPortfolioImportReconciliation(correctionScope),
            ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
        },
    );

    it.each([
        ["wrong scope", { reconciliationScope: "adopt_existing_only" }],
        [
            "missing existing transaction",
            {
                actions: [
                    {
                        ...correctionPreview().actions[0],
                        existingTransactionId: undefined,
                    },
                ],
            },
        ],
        [
            "no financial difference",
            {
                actions: [
                    { ...correctionPreview().actions[0], corrections: [] },
                ],
            },
        ],
        ["unselected new events", { summary: { adopt: 1, insert: 1 } }],
        [
            "contrary adoption policy",
            {
                actions: [
                    {
                        ...correctionPreview().actions[0],
                        policy: "preserve_existing",
                    },
                ],
            },
        ],
        [
            "custody action",
            {
                actions: [
                    { ...correctionPreview().actions[0], action: "transfer" },
                ],
                summary: { transfer: 1 },
            },
        ],
    ])("rejects a correction preview with %s", async (_name, changes) => {
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/preview`,
                () => ok({ ...correctionPreview(), ...changes }),
            ),
        );
        await expect(
            previewPortfolioImportReconciliation(correctionScope),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });

    it.each([
        [
            "new transactions",
            {
                imported: 1,
                batches: [{ ...correctionCommit().batches[0], imported: 1 }],
            },
        ],
        [
            "duplicate repair",
            {
                repaired: 1,
                duplicates: 2,
                batches: [
                    {
                        ...correctionCommit().batches[0],
                        repaired: 1,
                        duplicates: 2,
                    },
                ],
            },
        ],
        ["missing pending metadata", { pending: undefined }],
        [
            "full batch scope",
            {
                batches: [
                    {
                        ...correctionCommit().batches[0],
                        reconciliationScope: "full",
                    },
                ],
            },
        ],
    ])("rejects a correction commit reporting %s", async (_name, changes) => {
        server.use(
            http.post(
                `${API_BASE}/api/portfolio/import/reconciliation/commit`,
                () => ok({ ...correctionCommit(), ...changes }),
            ),
        );
        await expect(
            commitReviewedPortfolioImports({
                ...correctionScope,
                expectedPlanFingerprint: "bounded-review",
            }),
        ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
    });
});
