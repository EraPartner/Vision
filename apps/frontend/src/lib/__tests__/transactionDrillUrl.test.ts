import { describe, expect, it } from "vitest";
import { buildTransactionDrillUrl } from "@/lib/transactionDrillUrl";

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
        expect(buildTransactionDrillUrl({ categoryId: 7 })).toBe(
            "/transactions?category_id=7",
        );
        expect(buildTransactionDrillUrl({ categoryIds: [3, 8] })).toBe(
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
