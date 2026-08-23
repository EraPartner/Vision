import { describe, expect, it } from "vitest";
import en from "@/locales/en";
import nl from "@/locales/nl";

describe("TaxComputationFlow locale contract", () => {
    it("names the estimated property tax included in net take-home", () => {
        expect(en["tax.card.netTakeHome.desc"]).toContain("estimated property tax");
        expect(nl["tax.card.netTakeHome.desc"]).toContain("geschatte onroerende voorheffing");
    });
});
