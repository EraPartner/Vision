import { describe, expect, test } from "vitest";
import { accountFormSchema } from "../accountFormSchema";

/** The string slice of AccountFormValues the schema owns. */
const base = {
    name: "KBC Checking",
    display_name: "  KBC  ",
    institution: " KBC ",
    currency: "eur",
};

describe("accountFormSchema", () => {
    test("normalizes name/display_name/institution trims and uppercases the currency", () => {
        const result = accountFormSchema().safeParse({
            ...base,
            name: " KBC Checking ",
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.name).toBe("KBC Checking");
            expect(result.data.display_name).toBe("KBC");
            expect(result.data.institution).toBe("KBC");
            expect(result.data.currency).toBe("EUR");
        }
    });

    test("empty currency falls back to EUR", () => {
        const result = accountFormSchema().safeParse({
            ...base,
            currency: "  ",
        });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.currency).toBe("EUR");
    });

    test("whitespace-only name is rejected on the name path", () => {
        const result = accountFormSchema().safeParse({ ...base, name: "   " });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0].path[0]).toBe("name");
            expect(result.error.issues[0].message).toBe("validation.required");
        }
    });
});
