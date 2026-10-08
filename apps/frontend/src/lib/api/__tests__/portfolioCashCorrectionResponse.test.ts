// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";
import { previewPortfolioImportReconciliation } from "../portfolioImports";

const scope = {
    batchIds: [11],
    adoptPolicy: "prefer_source" as const,
    reconciliationScope: "correct_existing_only" as const,
};
function response() {
    return {
        batchIds: [11],
        adoptPolicy: "prefer_source",
        batchPolicies: [],
        planFingerprint: "native-cash-proof",
        ready: true,
        reconciliationScope: "correct_existing_only",
        pending: 0,
        complete: true,
        deferredCounts: {},
        selectedRowIds: [1],
        actions: [
            {
                batchId: 11,
                rowId: 1,
                rowOrdinal: 1,
                action: "adopt",
                isCash: true,
                investmentId: null as number | null,
                policy: "prefer_source",
                existingTransactionId: 99,
                source: {
                    date: "2025-01-02",
                    amount: "-123.4500",
                    currency: "USD",
                },
                existing: {
                    date: "2025-01-02",
                    amount: "-110.0000",
                    currency: "EUR",
                },
                corrections: ["amount", "currency"],
                economicsProven: true,
            },
        ],
        blockers: [],
        summary: { adopt: 1 },
    };
}
function serve(body: ReturnType<typeof response>) {
    server.use(
        http.post(
            `${API_BASE}/api/portfolio/import/reconciliation/preview`,
            () => ok(body),
        ),
    );
}
afterEach(() => server.resetHandlers());

describe("native cash correction review responses", () => {
    it("retains signed native amounts and the cash discriminator in a bounded correction preview", async () => {
        serve(response());
        const reviewed = await previewPortfolioImportReconciliation(scope);
        expect(reviewed.actions[0]).toMatchObject({
            isCash: true,
            investmentId: null,
            existingTransactionId: 99,
            source: { amount: "-123.4500", currency: "USD" },
            existing: { amount: "-110.0000", currency: "EUR" },
            corrections: ["amount", "currency"],
        });
    });

    it.each(["investment", "date", "zero", "currency", "fees"] as const)(
        "rejects %s evidence instead of exposing a commit-ready cash preview",
        async (defect) => {
            const body = response();
            const action = body.actions[0];
            if (defect === "investment") action.investmentId = 1;
            if (defect === "date") action.source.date = "2025-01-03";
            if (defect === "zero") action.source.amount = "0";
            if (defect === "currency") action.source.currency = "dollars";
            if (defect === "fees") action.corrections.push("fees");
            serve(body);
            await expect(
                previewPortfolioImportReconciliation(scope),
            ).rejects.toMatchObject({ name: "PortfolioImportResponseError" });
        },
    );
});
