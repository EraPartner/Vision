// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("category and recipient delete consequences", () => {
    const english = JSON.parse(
        readFileSync(join(process.cwd(), "../../i18n/source/en.json"), "utf8"),
    ) as Record<string, string>;
    const dutch = JSON.parse(
        readFileSync(join(process.cwd(), "../../i18n/source/nl.json"), "utf8"),
    ) as Record<string, string>;

    it("keeps target placeholders and consequences aligned in English and Dutch", () => {
        expect(english["categoriesPage.delete.desc"]).toContain("{name}");
        expect(english["categoriesPage.delete.desc"]).toContain("become uncategorized");
        expect(english["categoriesPage.delete.desc"]).toContain("default categories will be cleared");
        expect(english["recipientsPage.delete.desc"]).toContain("{name}");
        expect(english["recipientsPage.delete.desc"]).toContain("bank account links cannot be deleted");
        expect(english["recipientsPage.delete.desc"]).toContain("Reassign or merge them first");

        expect(dutch["categoriesPage.delete.desc"]).toContain("{name}");
        expect(dutch["categoriesPage.delete.desc"]).toContain("ongecategoriseerd");
        expect(dutch["recipientsPage.delete.desc"]).toContain("{name}");
        expect(dutch["recipientsPage.delete.desc"]).toContain("bankrekeningkoppelingen");
    });
});
