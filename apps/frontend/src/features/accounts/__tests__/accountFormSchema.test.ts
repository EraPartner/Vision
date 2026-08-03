import { describe, expect, test } from "vitest";
import { accountFormSchema } from "../accountFormSchema";

/** The string slice of AccountFormValues the schema owns. */
const base = {
  name: "KBC Checking",
  display_name: "  KBC  ",
  institution: " KBC ",
  currency: "eur",
  statementBalance: "",
  statementBalanceDate: "",
};

describe("accountFormSchema", () => {
  test("normalizes name/display_name/institution trims and uppercases the currency", () => {
    const result = accountFormSchema("create").safeParse({ ...base, name: " KBC Checking " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("KBC Checking");
      expect(result.data.display_name).toBe("KBC");
      expect(result.data.institution).toBe("KBC");
      expect(result.data.currency).toBe("EUR");
    }
  });

  test("empty currency falls back to EUR", () => {
    const result = accountFormSchema("create").safeParse({ ...base, currency: "  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.currency).toBe("EUR");
  });

  test("whitespace-only name is rejected on the name path", () => {
    const result = accountFormSchema("create").safeParse({ ...base, name: "   " });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path[0]).toBe("name");
      expect(result.error.issues[0].message).toBe("validation.required");
    }
  });

  test("edit mode rejects a statement balance without its as-of date (ADR-094)", () => {
    const result = accountFormSchema("edit").safeParse({ ...base, statementBalance: "1284.4" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path[0]).toBe("statementBalanceDate");
      expect(result.error.issues[0].message).toBe("accounts.field.statementBalanceDate");
    }
  });

  test("edit mode passes with balance + date, keeping the raw balance string", () => {
    const result = accountFormSchema("edit").safeParse({
      ...base,
      statementBalance: "1284.4",
      statementBalanceDate: "2026-06-03",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.statementBalance).toBe("1284.4");
      expect(result.data.statementBalanceDate).toBe("2026-06-03");
    }
  });

  test("the statement rule is edit-only — create ignores the combination", () => {
    const result = accountFormSchema("create").safeParse({ ...base, statementBalance: "10" });
    expect(result.success).toBe(true);
  });

  test("a missing name wins over the statement rule (silent-return order preserved)", () => {
    const result = accountFormSchema("edit").safeParse({
      ...base,
      name: "",
      statementBalance: "10",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Both issues are reported (Zod runs the object-level rule too), with
      // the name issue first — the dialog checks for a name issue before the
      // statement one, so the historical "name first, silently" order holds.
      expect(result.error.issues.map((i) => i.path[0])).toEqual(["name", "statementBalanceDate"]);
    }
  });
});
