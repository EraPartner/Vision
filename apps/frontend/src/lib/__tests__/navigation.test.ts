import { Briefcase, Import } from "lucide-react";
import { describe, expect, it } from "vitest";
import { ALL_NAV_ITEMS } from "@/lib/navigation";

describe("navigation registry", () => {
    it("distinguishes the budgeting and portfolio importers by icon", () => {
        const budgetingImport = ALL_NAV_ITEMS.find((item) => item.url === "/import");
        const portfolioImport = ALL_NAV_ITEMS.find((item) => item.url === "/portfolio/import");

        expect(budgetingImport?.icon).toBe(Import);
        expect(portfolioImport?.icon).toBe(Briefcase);
        expect(portfolioImport?.icon).not.toBe(budgetingImport?.icon);
    });
});
