import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPool, closeTestPool } from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import recipientRepository from "../src/repositories/recipientRepository.ts";
import { must } from "./helpers/must.ts";
import type { RecipientId } from "@vision/types/brands";

// A real database is essential: the database's own ilike() folds ASCII only
// (the C locale), so only a real query shows that recipient search folds
// Unicode case as PostgreSQL's pg_unicode_fast ILIKE did.
describe("recipient Unicode search", () => {
  const ids: number[] = [];
  beforeAll(async () => {
    for (const [name, notes] of [
      ["QA CAFÉ 🧪 unicode-search", ""],
      ["QA Élise unicode-search", "RÉSUMÉ unicode-note"],
      ["QA ΟΔΟΣ unicode-sigma", ""],
      ["QA 50% OFF unicode-literal", ""],
    ]) {
      const result = await getTestPool().query<{
        id: RecipientId;
      }>(
        "INSERT INTO recipients (name, normalized_name, notes) VALUES ($1, $2, $3) RETURNING id",
        [name, name, notes],
      );
      ids.push(must(result.rows[0], "result.rows[0]").id);
    }
  }, 180_000);
  afterAll(async () => {
    if (ids.length > 0)
      await getTestPool().query(
        "DELETE FROM recipients WHERE id IN (SELECT value FROM json_each($1))",
        [JSON.stringify(ids)],
      );
    await closeTestPool();
    await closePool();
  });
  it("matches accented names in list and total without making accents optional", async () => {
    for (const search of [
      "QA Café 🧪 unicode-search",
      "qa café 🧪 unicode-search",
    ]) {
      expect(
        (await recipientRepository.getAll({ search })).map((r) => r.id),
      ).toEqual([ids[0]]);
      expect(await recipientRepository.getCount({ search })).toBe(1);
    }
    expect(
      await recipientRepository.getCount({
        search: "QA Cafe 🧪 unicode-search",
      }),
    ).toBe(0);
  });
  it("uses Unicode matching for the name filter and notes, including mixed-case stored data", async () => {
    expect(
      (
        await recipientRepository.getAll({ name: "qa élise unicode-search" })
      ).map((r) => r.id),
    ).toEqual([ids[1]]);
    expect(
      await recipientRepository.getCount({ name: "qa élise unicode-search" }),
    ).toBe(1);
    expect(
      (await recipientRepository.getAll({ search: "résumé unicode-note" })).map(
        (r) => r.id,
      ),
    ).toEqual([ids[1]]);
    expect(
      await recipientRepository.getCount({ search: "résumé unicode-note" }),
    ).toBe(1);
  });
  it("matches a word-final capital sigma with the final lower-case form", async () => {
    // PostgreSQL lowered 'ΟΔΟΣ' to 'οδος'.
    expect(
      (await recipientRepository.getAll({ search: "qa οδος unicode-sigma" })).map(
        (r) => r.id,
      ),
    ).toEqual([ids[2]]);
  });
  it("keeps ILIKE wildcards: % is any run, _ one character, \\ escapes", async () => {
    expect(
      (await recipientRepository.getAll({ search: "qa c_fé" })).map((r) => r.id),
    ).toEqual([ids[0]]);
    expect(
      (await recipientRepository.getAll({ search: "qa%unicode-search" })).map(
        (r) => r.id,
      ),
    ).toEqual([ids[0], ids[1]]);
    expect(
      (await recipientRepository.getAll({ search: "50\\% off" })).map((r) => r.id),
    ).toEqual([ids[3]]);
    expect(await recipientRepository.getCount({ search: "qa c\\_fé" })).toBe(0);
  });
});
