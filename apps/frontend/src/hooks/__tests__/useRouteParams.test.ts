// @vitest-environment node
import { describe, expect, it } from "vitest";
import { asAccountId } from "@vision/types/brands";
import { parseRouteParams } from "@/hooks/useRouteParams";
import {
    asImportBatchId,
    asPortfolioImportBatchId,
    isAppPath,
    ROUTES,
    type AppPath,
} from "@/lib/routes";

describe("parseRouteParams", () => {
    it("parses an account id", () => {
        expect(parseRouteParams(ROUTES.account, { id: "42" })).toEqual({
            id: 42,
        });
    });

    it.each(["abc", "0", "-3", "1.5", "", "1e2", "9007199254740993"])(
        "rejects account id %j",
        (id) => {
            expect(parseRouteParams(ROUTES.account, { id })).toBeNull();
        },
    );

    it("rejects a missing account id", () => {
        expect(parseRouteParams(ROUTES.account, {})).toBeNull();
    });

    it("parses import batch ids for both review pages", () => {
        expect(
            parseRouteParams(ROUTES.importReview, { batchId: "7" }),
        ).toEqual({ batchId: 7 });
        expect(
            parseRouteParams(ROUTES.portfolioImportReview, { batchId: "9" }),
        ).toEqual({ batchId: 9 });
        expect(
            parseRouteParams(ROUTES.importReview, { batchId: "x" }),
        ).toBeNull();
        expect(
            parseRouteParams(ROUTES.portfolioImportReview, {}),
        ).toBeNull();
    });

    it("passes the table name through and rejects an empty one", () => {
        expect(
            parseRouteParams(ROUTES.adminDbTable, { table: "accounts" }),
        ).toEqual({ table: "accounts" });
        expect(parseRouteParams(ROUTES.adminDbTable, {})).toBeNull();
    });
});

describe("typed param paths", () => {
    it("accept branded ids and keep the URL", () => {
        const account: AppPath = `/accounts/${asAccountId(5)}`;
        const withQuery: AppPath = `/accounts/${asAccountId(5)}?since=2025-01-01`;
        const review: AppPath = `/import/${asImportBatchId(3)}/review`;
        const portfolioReview: AppPath = `/portfolio/import/${asPortfolioImportBatchId(3)}/review`;
        expect(account).toBe("/accounts/5");
        expect(withQuery).toBe("/accounts/5?since=2025-01-01");
        expect(review).toBe("/import/3/review");
        expect(portfolioReview).toBe("/portfolio/import/3/review");
        for (const path of [account, withQuery, review, portfolioReview]) {
            expect(isAppPath(path)).toBe(true);
        }
    });

    it("reject a plain number or the other kind of id at compile time", () => {
        const plain = Number("5");
        // @ts-expect-error a plain number is not an AccountId
        const a: AppPath = `/accounts/${plain}`;
        // @ts-expect-error a transaction import batch id is not a portfolio import batch id
        const b: AppPath = `/portfolio/import/${asImportBatchId(3)}/review`;
        // @ts-expect-error an account id is not a batch id
        const c: AppPath = `/import/${asAccountId(3)}/review`;
        expect([a, b, c]).toHaveLength(3);
    });
});
