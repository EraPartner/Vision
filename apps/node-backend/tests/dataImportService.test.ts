/**
 * Mocked-repository suite for the CSV importers.
 *
 * The connection mock below exposes `query` only — no `withTransaction` — so
 * the batched resolve cannot run and every case here drives the per-row
 * fallback, which is exactly what this suite is for: the fallback must keep
 * behaving like the loop that shipped before the batching. The batched path
 * needs real SQL semantics (ON CONFLICT arbiters, normalized-name matching) and
 * is covered against a real database in dataImport.db.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";

import { mockLogger } from "./helpers/mockLogger.ts";
vi.mock("fs", () => ({
  default: { promises: { readFile: vi.fn() } },
  promises: { readFile: vi.fn() },
}));

vi.mock("csv-parse/sync", () => ({
  parse: vi.fn(),
}));

vi.mock("../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));

vi.mock("../src/database/connection.ts", () => mockConnection());

vi.mock("../src/repositories/recipientRepository.ts", () => ({
  recipientRepository: {
    createOrGet: vi.fn(),
  },
}));

vi.mock("../src/repositories/categoryRepository.ts", () => ({
  categoryRepository: {
    createOrGet: vi.fn(),
  },
}));

vi.mock("../src/repositories/recipientBankAccountRepository.ts", () => ({
  recipientBankAccountRepository: {
    createOrGet: vi.fn(),
  },
}));

import fs from "fs";
import { parse as rawParse } from "csv-parse/sync";
import { logger } from "../src/config/logger.ts";
import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import { recipientRepository as rawRecipientRepository } from "../src/repositories/recipientRepository.ts";
import { categoryRepository as rawCategoryRepository } from "../src/repositories/categoryRepository.ts";
import { recipientBankAccountRepository as rawRecipientBankAccountRepository } from "../src/repositories/recipientBankAccountRepository.ts";
import {
  importRecipientsCSV,
  importCategoriesCSV,
} from "../src/services/dataImportService.ts";
import { loose, partial } from "./helpers/partial.ts";

const readFile = vi.mocked(fs.promises.readFile);
// csv-parse's overloaded generic signature does not survive vi.mocked; the
// importers parse with `columns: true`, so the stub yields object records.
const parse = vi.mocked(rawParse) as unknown as Mock<
  (input: string | Buffer, options?: object) => Record<string, string>[]
>;
const query = vi.mocked(rawQuery);
const recipientRepository = vi.mocked(rawRecipientRepository);
const categoryRepository = vi.mocked(rawCategoryRepository);
const recipientBankAccountRepository = vi.mocked(
  rawRecipientBankAccountRepository,
);
type RecipientCreateOrGet = Awaited<
  ReturnType<typeof rawRecipientRepository.createOrGet>
>;
type CategoryCreateOrGet = Awaited<
  ReturnType<typeof rawCategoryRepository.createOrGet>
>;

describe("Data Import Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFile.mockResolvedValue("csv-content");
  });

  describe("shared CSV decoding", () => {
    it.each([
      ["latin-1", Buffer.from("name\nCafé", "latin1"), "name\nCafé"],
      ["iso-8859-1", Buffer.from("name\nCafé", "latin1"), "name\nCafé"],
      [
        "windows-1252",
        Buffer.concat([
          Buffer.from("name\n"),
          Buffer.from([0x80, 0x93, 0xe9, 0x94]),
        ]),
        "name\n€“é”",
      ],
    ])(
      "decodes %s for recipients and categories",
      async (encoding, bytes, text) => {
        readFile.mockResolvedValue(bytes);
        parse.mockReturnValue([]);
        await importRecipientsCSV("/tmp/encoding.csv", { encoding });
        await importCategoriesCSV("/tmp/encoding.csv", { encoding });
        expect(parse).toHaveBeenNthCalledWith(1, text, expect.any(Object));
        expect(parse).toHaveBeenNthCalledWith(2, text, expect.any(Object));
      },
    );

    it("rejects unsupported encodings instead of silently defaulting", async () => {
      await expect(
        importRecipientsCSV("/tmp/encoding.csv", { encoding: "bogus" }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        importCategoriesCSV("/tmp/encoding.csv", { encoding: "bogus" }),
      ).rejects.toMatchObject({ status: 400 });
      expect(fs.promises.readFile).not.toHaveBeenCalled();
    });
  });

  describe("importRecipientsCSV", () => {
    it("should return zeroed results for empty files", async () => {
      parse.mockReturnValue([]);

      const result = await importRecipientsCSV("/tmp/recipients.csv");

      expect(result).toEqual({
        total_processed: 0,
        imported: 0,
        skipped: 0,
        errors: 0,
        bank_account_errors: 0,
      });
    });

    it("should increment errors when recipient name is missing", async () => {
      parse.mockReturnValue([{ name: "   " }]);

      const result = await importRecipientsCSV("/tmp/recipients.csv");

      expect(result.errors).toBe(1);
      expect(result.imported).toBe(0);
      expect(recipientRepository.createOrGet).not.toHaveBeenCalled();
    });

    it("should increment imported when recipient is newly created", async () => {
      parse.mockReturnValue([{ name: "Alice" }]);
      recipientRepository.createOrGet.mockResolvedValue(
        partial<RecipientCreateOrGet>({
          recipient: { id: 1 },
          created: true,
        }),
      );

      const result = await importRecipientsCSV("/tmp/recipients.csv");

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it("should increment skipped when recipient already exists", async () => {
      parse.mockReturnValue([{ name: "Alice" }]);
      recipientRepository.createOrGet.mockResolvedValue(
        partial<RecipientCreateOrGet>({
          recipient: { id: 1 },
          created: false,
        }),
      );

      const result = await importRecipientsCSV("/tmp/recipients.csv");

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("should swallow bank account create failures and continue", async () => {
      parse.mockReturnValue([
        { name: "Alice", bank_account: "BE11 1111 1111 1111" },
      ]);
      recipientRepository.createOrGet.mockResolvedValue(
        partial<RecipientCreateOrGet>({
          recipient: { id: 1 },
          created: true,
        }),
      );
      recipientBankAccountRepository.createOrGet.mockRejectedValue(
        new Error("invalid iban"),
      );

      const result = await importRecipientsCSV("/tmp/recipients.csv");

      expect(result.imported).toBe(1);
      expect(result.errors).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("could not add bank account"),
      );
    });

    it("should create category and update default category only when null", async () => {
      parse.mockReturnValue([{ name: "Alice", category: "food:groceries" }]);
      recipientRepository.createOrGet.mockResolvedValue(
        partial<RecipientCreateOrGet>({
          recipient: { id: 42 },
          created: true,
        }),
      );
      categoryRepository.createOrGet.mockResolvedValue(
        partial<CategoryCreateOrGet>({
          category: { id: 9 },
          created: true,
        }),
      );
      query.mockResolvedValue(partial<PgQueryResult>({ rows: [] }));

      await importRecipientsCSV("/tmp/recipients.csv");

      expect(categoryRepository.createOrGet).toHaveBeenCalledWith({
        general: "FOOD",
        detail: "GROCERIES",
      });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("default_category_id IS NULL"),
        [9, 42],
      );
    });

    it("should warn and continue on invalid category format", async () => {
      parse.mockReturnValue([{ name: "Alice", category: "INVALID_FORMAT" }]);
      recipientRepository.createOrGet.mockResolvedValue(
        partial<RecipientCreateOrGet>({
          recipient: { id: 1 },
          created: true,
        }),
      );

      const result = await importRecipientsCSV("/tmp/recipients.csv");

      expect(result.imported).toBe(1);
      expect(categoryRepository.createOrGet).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid category format"),
      );
    });

    it("should fall back to the per-row loop when the batched resolve is unavailable", async () => {
      parse.mockReturnValue([{ name: "Alice" }, { name: "Bob" }]);
      recipientRepository.createOrGet
        .mockResolvedValueOnce(
          partial<RecipientCreateOrGet>({
            recipient: { id: 1 },
            created: true,
          }),
        )
        .mockResolvedValueOnce(
          partial<RecipientCreateOrGet>({
            recipient: { id: 2 },
            created: false,
          }),
        );

      const result = await importRecipientsCSV("/tmp/recipients.csv");

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("falling back to per-row"),
      );
      expect(recipientRepository.createOrGet).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        total_processed: 2,
        imported: 1,
        skipped: 1,
        errors: 0,
        bank_account_errors: 0,
      });
    });

    it("should throw CSV parse errors with explicit prefix", async () => {
      parse.mockImplementation(() => {
        throw new Error("invalid quote at line 2");
      });

      await expect(importRecipientsCSV("/tmp/recipients.csv")).rejects.toThrow(
        "CSV parse error: invalid quote at line 2",
      );
    });
  });

  describe("importCategoriesCSV", () => {
    it("should import using explicit category header column", async () => {
      parse.mockReturnValue([{ category: "food:groceries" }]);
      categoryRepository.createOrGet.mockResolvedValue(
        partial<CategoryCreateOrGet>({
          category: { id: 1 },
          created: true,
        }),
      );

      const result = await importCategoriesCSV("/tmp/categories.csv");

      expect(categoryRepository.createOrGet).toHaveBeenCalledWith({
        general: "FOOD",
        detail: "GROCERIES",
      });
      expect(result.imported).toBe(1);
    });

    it("should fall back to first column when category header is missing", async () => {
      parse.mockReturnValue([{ custom_col: "utilities:electricity" }]);
      categoryRepository.createOrGet.mockResolvedValue(
        partial<CategoryCreateOrGet>({
          category: { id: 2 },
          created: true,
        }),
      );

      await importCategoriesCSV("/tmp/categories.csv");

      expect(categoryRepository.createOrGet).toHaveBeenCalledWith({
        general: "UTILITIES",
        detail: "ELECTRICITY",
      });
    });

    it("should increment errors for invalid category format", async () => {
      parse.mockReturnValue([{ category: "INVALID" }]);

      const result = await importCategoriesCSV("/tmp/categories.csv");

      expect(result.errors).toBe(1);
      expect(result.imported).toBe(0);
    });

    it("should increment errors for empty general or detail parts", async () => {
      parse.mockReturnValue([
        { category: "FOOD:" },
        { category: ":GROCERIES" },
      ]);

      const result = await importCategoriesCSV("/tmp/categories.csv");

      expect(result.errors).toBe(2);
      expect(categoryRepository.createOrGet).not.toHaveBeenCalled();
    });

    it("should map createOrGet outcomes to imported and skipped", async () => {
      parse.mockReturnValue([
        { category: "FOOD:GROCERIES" },
        { category: "TRANSPORT:FUEL" },
      ]);
      categoryRepository.createOrGet
        .mockResolvedValueOnce(
          partial<CategoryCreateOrGet>({ category: { id: 1 }, created: true }),
        )
        .mockResolvedValueOnce(
          partial<CategoryCreateOrGet>({ category: { id: 2 }, created: false }),
        );

      const result = await importCategoriesCSV("/tmp/categories.csv");

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);
    });

    it("should throw CSV parse errors with explicit prefix", async () => {
      parse.mockImplementation(() => {
        throw new Error("delimiter issue");
      });

      await expect(importCategoriesCSV("/tmp/categories.csv")).rejects.toThrow(
        "CSV parse error: delimiter issue",
      );
    });
  });

  // Parsed CSV records go through a row schema each (recipientCsvRowSchema /
  // categoryCsvRowSchema); rejections stay counted errors with the same logs.
  describe("parsed-row schemas", () => {
    it("reads recipient headers case-insensitively and rejects a short row without a name", async () => {
      parse.mockReturnValue([
        { " NAME ": " Alice ", Account_Number: " BE11 ", Address: " Main St " },
        // relax_column_count: a short row leaves the name cell absent.
        loose<Record<string, string>>({ address: "Nowhere" }),
      ]);
      recipientRepository.createOrGet.mockResolvedValue(
        partial<RecipientCreateOrGet>({ recipient: { id: 1 }, created: true }),
      );
      query.mockResolvedValue(partial<PgQueryResult>({ rows: [] }));

      const result = await importRecipientsCSV("/tmp/recipients.csv");

      expect(result).toMatchObject({ imported: 1, errors: 1 });
      expect(recipientRepository.createOrGet).toHaveBeenCalledWith({
        name: "Alice",
      });
      expect(recipientBankAccountRepository.createOrGet).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 1, accountNumber: "BE11" }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "Recipient import: skipping row with missing name",
      );
    });

    it("logs the established category reasons and stays silent on an empty cell", async () => {
      parse.mockReturnValue([
        { category: "  " },
        loose<Record<string, string>>({}),
        { category: "NOCOLON" },
        { category: " FOOD: " },
      ]);

      const result = await importCategoriesCSV("/tmp/categories.csv");

      expect(result).toMatchObject({ total_processed: 4, errors: 4 });
      expect(vi.mocked(logger.warn).mock.calls).toEqual([
        ['Category import: invalid format "NOCOLON" — expected GENERAL:DETAIL'],
        ['Category import: empty general or detail in "FOOD:"'],
      ]);
      expect(categoryRepository.createOrGet).not.toHaveBeenCalled();
    });
  });
});
