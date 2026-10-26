/**
 * Real-Postgres tests for the recipient/category CSV importers.
 *
 * The mock suite (dataImportService.test.ts) stubs the repositories, so it
 * pins the per-row fallback and nothing else. This suite exists because the
 * importers were rewritten from a per-row loop (~5 round trips per recipient
 * row, 1-2 per category row) to a set-based resolve, and every semantic the
 * loop got from the database lives in SQL that a mock cannot show:
 *
 *   • `created` (→ imported) vs. existing (→ skipped) is decided by
 *     `ON CONFLICT DO NOTHING` on `recipients.normalized_name` and
 *     `categories (general, detail)`,
 *   • a repeat of a name *within one file* used to hit the row the earlier
 *     line had just inserted — the batched path has to reproduce that from JS,
 *   • matching is on the token-sorted, punctuation-stripped normalized name,
 *     not on the display name,
 *   • the notes / default-category writes are guarded so the first value in
 *     the file wins and an existing value is never overwritten.
 *
 * Every test also asserts the batched path actually ran: a silent throw would
 * fall back to the per-row loop, which produces the same counters by design and
 * would make the rest of the assertions blind.
 *
 * Isolation: the three tables this suite owns are emptied around each test.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { mockLogger } from "./helpers/mockLogger.ts";

vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));

// Wrap the module-level query() helper so the round-trip count is observable.
// Everything else (including withTransaction and its ambient-client routing)
// stays the real implementation.
vi.mock("../src/database/connection.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/database/connection.ts")>();
  return {
    ...actual,
    query: vi.fn((...args: Parameters<typeof actual.query>) =>
      actual.query<DbRow>(...args),
    ),
  };
});

import {
  acquireDbSuiteLock,
  closeTestPool,
  deleteAllCategoryFixtures,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { logger } from "../src/config/logger.ts";
import { closePool, query } from "../src/database/connection.ts";
import { recipientRepository } from "../src/repositories/recipientRepository.ts";
import { categoryRepository } from "../src/repositories/categoryRepository.ts";
import {
  mergeCategoryNodes,
  updateCategoryNode,
} from "../src/repositories/categoryHierarchyRepository.ts";
import {
  importCategoriesCSV,
  importRecipientsCSV,
} from "../src/services/dataImportService.ts";
import { useTempCSV } from "./helpers/tempFile.ts";
import { must } from "./helpers/must.ts";
import type { CategoryId } from "@vision/types/brands";
import { loose } from "./helpers/partial.ts";
import type { LoggerMock } from "./helpers/mockLogger.ts";
import type { Mock } from "vitest";

const loggerMock = loose<LoggerMock>(logger);
/** The given methods of `T`, typed as the spies a `vi.mock` factory installed. */
type Spies<T, K extends keyof T> = Record<
  K,
  Mock<Extract<T[K], (...args: never[]) => unknown>>
>;

const recipientRepositoryMock =
  loose<Spies<typeof recipientRepository, "createOrGet">>(recipientRepository);
const categoryRepositoryMock =
  loose<Spies<typeof categoryRepository, "createOrGet">>(categoryRepository);

/** A result row whose columns the test reads without a fixed shape. */
type DbRow = Record<string, unknown>;

const maybePool = getTestPool();
const pool = () => must(maybePool, "test pool");
const describeDb = hasTestDatabase() ? describe : describe.skip;
const writeTempCSV = useTempCSV("data_import");

/** The batched path must be what ran — the fallback would mask everything. */
function expectBatchedPathRan() {
  const fellBack = loggerMock.warn.mock.calls.some((args) =>
    String(args[0]).includes("falling back to per-row"),
  );
  expect(fellBack).toBe(false);
}

async function recipientRow(normalizedName: string) {
  const { rows } = await pool().query<DbRow>(
    `SELECT r.id, r.name, r.notes, c.general, c.detail
       FROM recipients r
       LEFT JOIN categories c ON c.id = r.default_category_id
      WHERE r.normalized_name = $1`,
    [normalizedName],
  );
  return rows[0] ?? null;
}

describeDb("data import (real Postgres)", () => {
  beforeAll(acquireDbSuiteLock, 180_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    await pool().query("DELETE FROM recipient_bank_accounts");
    await pool().query("DELETE FROM recipients");
    await deleteAllCategoryFixtures(pool());
  });

  afterEach(async () => {
    await pool().query("DELETE FROM recipient_bank_accounts");
    await pool().query("DELETE FROM recipients");
    await deleteAllCategoryFixtures(pool());
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  describe("importRecipientsCSV", () => {
    it("counts a name repeated inside one file as created once, skipped after", async () => {
      const file = writeTempCSV("name\nAlice\nBob\nalice\nALICE\n");

      const result = await importRecipientsCSV(file);

      expect(result).toEqual({
        total_processed: 4,
        imported: 2,
        skipped: 2,
        errors: 0,
        bank_account_errors: 0,
      });
      const { rows } = await pool().query<DbRow>(
        "SELECT name FROM recipients ORDER BY name",
      );
      expect(rows.map((/** @type {any} */ r) => r.name)).toEqual([
        "ALICE",
        "BOB",
      ]);
      expectBatchedPathRan();
    });

    it("matches a pre-existing recipient on the token-sorted normalized name", async () => {
      await pool().query(
        `INSERT INTO recipients (name, normalized_name) VALUES ('JOHN SMITH', 'JOHN SMITH')`,
      );

      const result = await importRecipientsCSV(
        writeTempCSV('name\n"Smith, John"\nJohn F. Smith\n'),
      );

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(2);
      const { rows } = await pool().query<DbRow>(
        "SELECT count(*)::int AS n FROM recipients",
      );
      expect(must(rows[0], "rows[0]").n).toBe(1);
      expectBatchedPathRan();
    });

    it("writes the first address of the file to notes and never overwrites one", async () => {
      await pool().query(
        `INSERT INTO recipients (name, normalized_name, notes)
         VALUES ('OLD', 'OLD', 'kept')`,
      );

      const result = await importRecipientsCSV(
        writeTempCSV(
          "name,address\nOld,ignored addr\nNew,first addr\nNew,second addr\n",
        ),
      );

      expect(result).toMatchObject({ imported: 1, skipped: 2, errors: 0 });
      expect(must(await recipientRow("OLD"), "OLD recipient").notes).toBe(
        "kept",
      );
      expect(must(await recipientRow("NEW"), "NEW recipient").notes).toBe(
        "first addr",
      );
      expectBatchedPathRan();
    });

    it("assigns the first category named for a recipient and never overwrites one", async () => {
      const { rows: seeded } = await pool().query<{ id: CategoryId }>(
        `INSERT INTO categories (general, detail) VALUES ('HOME', 'RENT') RETURNING id`,
      );
      await pool().query(
        `INSERT INTO recipients (name, normalized_name, default_category_id)
         VALUES ('LANDLORD', 'LANDLORD', $1)`,
        [must(seeded[0], "seeded[0]").id],
      );

      const result = await importRecipientsCSV(
        writeTempCSV(
          "name,category\nCarol,food:groceries\nCarol,transport:fuel\nLandlord,food:groceries\n" +
            "Gina,INVALID_FORMAT\nHank,FOOD:\n",
        ),
      );

      expect(result).toMatchObject({ imported: 3, skipped: 2, errors: 0 });
      // No ':' at all warns; an empty part after a well-placed ':' is a silent
      // skip. Neither is a row error, and neither recipient gets a category.
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining('invalid category format "INVALID_FORMAT"'),
      );
      expect(loggerMock.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('"FOOD:"'),
      );
      expect(await recipientRow("GINA")).toMatchObject({ general: null });
      expect(await recipientRow("HANK")).toMatchObject({ general: null });
      expect(await recipientRow("CAROL")).toMatchObject({
        general: "FOOD",
        detail: "GROCERIES",
      });
      expect(await recipientRow("LANDLORD")).toMatchObject({
        general: "HOME",
        detail: "RENT",
      });
      // Both categories the file names are created even when the assignment
      // they were named for is a no-op.
      const { rows: cats } = await pool().query<DbRow>(
        "SELECT general, detail FROM categories WHERE legacy_compatible = true ORDER BY general",
      );
      expect(cats).toEqual([
        { general: "FOOD", detail: "GROCERIES" },
        { general: "HOME", detail: "RENT" },
        { general: "TRANSPORT", detail: "FUEL" },
      ]);
      expectBatchedPathRan();
    });

    it("links bank accounts per row and charges rejected ones to bank_account_errors", async () => {
      const tooLong = "BE".padEnd(40, "9"); // account_number is VARCHAR(34)
      const result = await importRecipientsCSV(
        writeTempCSV(`name,bank_account\nDana,BE11 1111\nErin,${tooLong}\n`),
      );

      expect(result).toMatchObject({
        imported: 2,
        skipped: 0,
        errors: 0,
        bank_account_errors: 1,
      });
      const { rows } = await pool().query<DbRow>(
        `SELECT account_number, is_primary FROM recipient_bank_accounts`,
      );
      expect(rows).toEqual([{ account_number: "BE11 1111", is_primary: true }]);
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining('could not add bank account for "Erin"'),
      );
      expectBatchedPathRan();
    });

    it("counts a row with no name as an error and imports the rest", async () => {
      const result = await importRecipientsCSV(
        writeTempCSV("name,address\n   ,nowhere\nFrank,\n"),
      );

      expect(result).toMatchObject({
        total_processed: 2,
        imported: 1,
        skipped: 0,
        errors: 1,
      });
      expectBatchedPathRan();
    });

    it("resolves the whole file in a handful of statements", async () => {
      const rows = Array.from(
        { length: 60 },
        (_, i) => `Recipient ${i},cat ${i % 4}:detail`,
      );
      vi.spyOn(recipientRepository, "createOrGet");
      vi.spyOn(categoryRepository, "createOrGet");

      const result = await importRecipientsCSV(
        writeTempCSV(`name,category\n${rows.join("\n")}\n`),
      );

      expect(result).toMatchObject({ imported: 60, skipped: 0, errors: 0 });
      // Two resolve statements per entity plus the one batched category
      // assignment; the per-row loop issued ~5 statements per row.
      expect(vi.mocked(query).mock.calls.length).toBeLessThanOrEqual(6);
      expect(recipientRepositoryMock.createOrGet).not.toHaveBeenCalled();
      expect(categoryRepositoryMock.createOrGet).not.toHaveBeenCalled();
      const { rows: assigned } = await pool().query<DbRow>(
        `SELECT count(*)::int AS n FROM recipients WHERE default_category_id IS NOT NULL`,
      );
      expect(must(assigned[0], "assigned[0]").n).toBe(60);
      expectBatchedPathRan();
    });
  });

  describe("importCategoriesCSV", () => {
    it("creates each distinct pair once and counts repeats and pre-existing as skipped", async () => {
      await pool().query(
        `INSERT INTO categories (general, detail) VALUES ('FOOD', 'GROCERIES')`,
      );

      const result = await importCategoriesCSV(
        writeTempCSV(
          "category\nfood:groceries\nTransport:Fuel\ntransport: fuel\nHome:Rent\n",
        ),
      );

      expect(result).toEqual({
        total_processed: 4,
        imported: 2,
        skipped: 2,
        errors: 0,
      });
      const { rows } = await pool().query<DbRow>(
        "SELECT general, detail FROM categories WHERE legacy_compatible = true ORDER BY general",
      );
      expect(rows).toEqual([
        { general: "FOOD", detail: "GROCERIES" },
        { general: "HOME", detail: "RENT" },
        { general: "TRANSPORT", detail: "FUEL" },
      ]);
      expectBatchedPathRan();
    });

    it("counts malformed rows as errors without touching the valid ones", async () => {
      const result = await importCategoriesCSV(
        writeTempCSV(
          "category\nFOOD:GROCERIES\nINVALID\n\nFOOD:\n:GROCERIES\n",
        ),
      );

      expect(result).toMatchObject({ imported: 1, skipped: 0, errors: 3 });
      const { rows } = await pool().query<DbRow>(
        "SELECT count(*)::int AS n FROM categories WHERE legacy_compatible = true",
      );
      expect(must(rows[0], "rows[0]").n).toBe(1);
      expectBatchedPathRan();
    });

    it("resolves the whole file in a handful of statements", async () => {
      const rows = Array.from({ length: 60 }, (_, i) => `general ${i}:detail`);
      vi.spyOn(categoryRepository, "createOrGet");

      const result = await importCategoriesCSV(
        writeTempCSV(`category\n${rows.join("\n")}\n`),
      );

      expect(result).toMatchObject({ imported: 60, skipped: 0, errors: 0 });
      expect(vi.mocked(query).mock.calls.length).toBeLessThanOrEqual(4);
      expect(categoryRepositoryMock.createOrGet).not.toHaveBeenCalled();
      expectBatchedPathRan();
    });

    it("keeps old import pairs and root prefixes redirected through chained merges", async () => {
      const ids: CategoryId[] = [];
      for (const detail of ["FIRST", "SECOND", "THIRD"]) {
        const { rows } = await pool().query<{ id: CategoryId }>(
          "INSERT INTO categories (general, detail) VALUES ('FOOD', $1) RETURNING id",
          [detail],
        );
        ids.push(must(rows[0], "rows[0]").id);
      }
      const [firstId, secondId, thirdId] = [
        must(ids[0], "ids[0]"),
        must(ids[1], "ids[1]"),
        must(ids[2], "ids[2]"),
      ];
      await mergeCategoryNodes(firstId, secondId);
      await mergeCategoryNodes(secondId, thirdId);
      const alias = await categoryRepository.createOrGet({
        general: "FOOD",
        detail: "FIRST",
      });
      expect(alias).toMatchObject({
        category: { id: thirdId },
        created: false,
      });
      const result = await importCategoriesCSV(
        writeTempCSV("category\nFOOD:FIRST\nFOOD:SECOND\n"),
      );
      expect(result).toMatchObject({ imported: 0, skipped: 2, errors: 0 });
      expectBatchedPathRan();

      const root = await pool().query<{ parent_id: CategoryId }>(
        "SELECT parent_id FROM categories WHERE id=$1",
        [thirdId],
      );
      const rootParentId = must(root.rows[0], "root.rows[0]").parent_id;
      await updateCategoryNode(rootParentId, {
        name: "RENAMED FOOD",
      });
      const renamedImport = await categoryRepository.createOrGet({
        general: "FOOD",
        detail: "AFTER_RENAME",
      });
      const renamedParent = await pool().query<DbRow>(
        "SELECT parent_id FROM categories WHERE id=$1",
        [must(renamedImport.category, "renamedImport.category").id],
      );
      expect(
        must(renamedParent.rows[0], "renamedParent.rows[0]").parent_id,
      ).toBe(rootParentId);
      await updateCategoryNode(rootParentId, {
        name: "FOOD FINAL",
      });
      const middleNameImport = await categoryRepository.createOrGet({
        general: "RENAMED FOOD",
        detail: "AFTER_SECOND_RENAME",
      });
      const middleParent = await pool().query<DbRow>(
        "SELECT parent_id FROM categories WHERE id=$1",
        [must(middleNameImport.category, "middleNameImport.category").id],
      );
      expect(must(middleParent.rows[0], "middleParent.rows[0]").parent_id).toBe(
        rootParentId,
      );
      const otherRoot = await pool().query<{ id: CategoryId }>(
        "INSERT INTO categories (general,detail,name,hierarchy_only,legacy_compatible) VALUES ('OTHER','','OTHER',true,false) RETURNING id",
      );
      await mergeCategoryNodes(
        rootParentId,
        must(otherRoot.rows[0], "otherRoot.rows[0]").id,
      );
      const fresh = await categoryRepository.createOrGet({
        general: "FOOD",
        detail: "NEW",
      });
      expect(fresh.category).toMatchObject({ general: "FOOD", detail: "NEW" });
      const parent = await pool().query<DbRow>(
        "SELECT parent_id FROM categories WHERE id=$1",
        [must(fresh.category, "fresh.category").id],
      );
      expect(must(parent.rows[0], "parent.rows[0]").parent_id).toBe(
        must(otherRoot.rows[0], "otherRoot.rows[0]").id,
      );
      const oldRoot = await pool().query<{ id: CategoryId }>(
        "SELECT id FROM categories WHERE parent_id IS NULL AND name='FOOD'",
      );
      expect(oldRoot.rows).toEqual([]);
    });
  });
});
