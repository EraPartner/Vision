import { describe, expect, it } from "vitest";
import { buildTransactionDrillUrl } from "@/lib/transactionDrillUrl";
import { asCategoryId } from "@vision/types/brands";

describe("buildTransactionDrillUrl", () => {
    it("builds a leap-month income drill", () => {
        expect(
            buildTransactionDrillUrl({
                period: "2028-02",
                valueMode: "income",
                label: "Last month income",
            }),
        ).toBe(
            "/transactions?start_date=2028-02-01&end_date=2028-02-29&transaction_type=income&filter_label=Last+month+income",
        );
    });

    it("supports one category, many categories, and uncategorised rows", () => {
        expect(buildTransactionDrillUrl({ categoryId: asCategoryId(7) })).toBe(
            "/transactions?category_id=7",
        );
        expect(buildTransactionDrillUrl({ categoryIds: [asCategoryId(3), asCategoryId(8)] })).toBe(
            "/transactions?category_ids=3%2C8",
        );
        expect(buildTransactionDrillUrl({ uncategorised: true })).toBe(
            "/transactions?uncategorised=true",
        );
    });

    it("returns the plain transactions destination without filters", () => {
        expect(buildTransactionDrillUrl({})).toBe("/transactions");
    });
});
