/**
 * Builder writes read assigned values the way PostgreSQL's input functions
 * read the text node-postgres sent (ADR-263): booleans, dates, timestamps and
 * decimals reach the CHECKed storage forms instead of being refused.
 */
import { describe, expect, it } from "vitest";

import { db } from "../../src/database/db.ts";
import { booleanInput } from "../../src/database/sqlite/values.ts";
import { inRollbackTransaction } from "../setup/db.ts";
import type { DbRow } from "../setup/db.ts";
import { must } from "../helpers/must.ts";

const STORED = `SELECT CAST(is_latest AS TEXT) AS is_latest, CAST(rate_date AS TEXT) AS rate_date,
                       CAST(fetched_at AS TEXT) AS fetched_at, CAST(rate_to_eur AS TEXT) AS rate
                  FROM exchange_rates WHERE id = $1`;

function codeOf(err: unknown): unknown {
  return (err as { code?: unknown }).code;
}

describe("builder writes", () => {
  it("store what PostgreSQL stored for loose input on insert and update", async () => {
    await inRollbackTransaction(async (client) => {
      const inserted = must(
        await db
          .insertInto("exchange_rates")
          .values({
            currency_code: "USD",
            rate_to_eur: "1.23456789015",
            rate_date: "2026-01-05T23:30:00Z",
            is_latest: "yes" as unknown as boolean,
            fetched_at: "2026-01-05 10:00:00+02:00" as unknown as Date,
          })
          .returning("id")
          .executeTakeFirst(),
        "inserted rate",
      );
      expect(must((await client.query<DbRow>(STORED, [inserted.id])).rows[0], "row")).toEqual({
        is_latest: "1",
        rate_date: "2026-01-05",
        fetched_at: "2026-01-05T08:00:00.000000Z",
        rate: "1.2345678902",
      });

      await db
        .updateTable("exchange_rates")
        .set({ is_latest: " OFF " as unknown as boolean, rate_date: new Date(2026, 1, 1) })
        .where("id", "=", inserted.id)
        .execute();
      expect(must((await client.query<DbRow>(STORED, [inserted.id])).rows[0], "row")).toMatchObject({
        is_latest: "0",
        rate_date: "2026-02-01",
      });
    });
  });

  it("refuses input PostgreSQL refused, with its SQLSTATE", async () => {
    await inRollbackTransaction(async () => {
      const insert = (values: Record<string, unknown>) =>
        db
          .insertInto("exchange_rates")
          .values({ currency_code: "USD", rate_to_eur: "1", rate_date: "2026-01-05", ...values })
          .execute()
          .then(() => "ok", codeOf);
      expect(await insert({ is_latest: "maybe" })).toBe("22P02");
      expect(await insert({ rate_date: "2026-02-30T10:00:00Z" })).toBe("22008");
      expect(await insert({ rate_date: "tomorrow" })).toBe("22007");
    });
  });
});

describe("booleanInput", () => {
  it("accepts what boolin accepts and nothing else", () => {
    const yes = [true, "t", "TR", "true", "y", "Yes", "on", " 1 ", 1, 1n];
    const no = [false, "f", "fals", "n", "NO", "of", "off", "0", 0];
    for (const value of yes) expect(booleanInput(value), String(value)).toBe(true);
    for (const value of no) expect(booleanInput(value), String(value)).toBe(false);
    expect(booleanInput(null)).toBeNull();
    for (const value of ["", "o", "truee", "2", 2, "nope", "yess"]) {
      expect(() => booleanInput(value), JSON.stringify(value)).toThrow(
        expect.objectContaining({ code: "22P02" }),
      );
    }
  });
});
