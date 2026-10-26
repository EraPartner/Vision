import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  releaseDbSuiteLock,
  getTestPool,
  hasTestDatabase,
  closeTestPool,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import recipientRepository from "../src/repositories/recipientRepository.ts";
import { must } from "./helpers/must.ts";
import type { RecipientId } from "@vision/types/brands";

// Real PostgreSQL is essential: mocked ILIKE cannot expose the native C-locale bug.
describe.skipIf(!hasTestDatabase())("recipient Unicode search", () => {
  const ids: number[] = [];
  beforeAll(async () => {
    await acquireDbSuiteLock();
    for (const [name, notes] of [
      ["QA CAFÉ 🧪 unicode-search", ""],
      ["QA Élise unicode-search", "RÉSUMÉ unicode-note"],
    ]) {
      const result = await must(getTestPool(), "getTestPool()").query<{
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
      await must(getTestPool(), "getTestPool()").query(
        "DELETE FROM recipients WHERE id = ANY($1::int[])",
        [ids],
      );
    await releaseDbSuiteLock();
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
});
