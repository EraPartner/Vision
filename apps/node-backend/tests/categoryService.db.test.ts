/**
 * resolveCategoryIdByName against PostgreSQL: a category resolves by its path
 * or legacy General:Detail name only while it is active.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import categoryRepository from "../src/repositories/categoryRepository.ts";
import { resolveCategoryIdByName } from "../src/services/categoryService.ts";
import { must } from "./helpers/must.ts";

const pool = getTestPool();
const GENERAL = `CATSVC${process.pid}`;
const createdIds: number[] = [];

describe.skipIf(!hasTestDatabase())(
  "resolveCategoryIdByName against PostgreSQL",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180000);

    afterAll(async () => {
      try {
        await must(pool, "pool").query("DELETE FROM categories WHERE id = ANY($1)", [
          createdIds,
        ]);
      } finally {
        try {
          await releaseDbSuiteLock();
        } finally {
          try {
            await closeTestPool();
          } finally {
            await closePool();
          }
        }
      }
    });

    it("only resolves active categories", async () => {
      const { category } = await categoryRepository.createOrGet({
        general: GENERAL,
        detail: "ACTIVE",
      });
      createdIds.push(must(category, "category").id);

      expect(await resolveCategoryIdByName(`${GENERAL}:ACTIVE`)).toBe(
        must(category, "category").id,
      );

      await categoryRepository.update(must(category, "category").id, { is_active: false });

      await expect(
        resolveCategoryIdByName(`${GENERAL}:ACTIVE`),
      ).rejects.toThrow("does not exist");
    });
  },
);
