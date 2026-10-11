/**
 * Runs every row-checked catalog query (src/database/rows/catalog.ts) against
 * a migrated PostgreSQL database, so a schema that disagrees with what pg
 * really returns fails here (tests run the contracts in throw mode).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool, withTransaction } from "../src/database/connection.ts";
import attachmentModule from "../src/repositories/attachmentRepository.ts";
import categoryRepository from "../src/repositories/categoryRepository.ts";
import {
  createCategoryNode,
  deleteCategoryNode,
  getCategoryNode,
  listCategoryNodes,
  mergeCategoryNodes,
  updateCategoryNode,
} from "../src/repositories/categoryHierarchyRepository.ts";
import recipientBankAccountRepository from "../src/repositories/recipientBankAccountRepository.ts";
import recipientRepository from "../src/repositories/recipientRepository.ts";
import savedChartsRepository from "../src/repositories/savedChartsRepository.ts";
import settingsRepository from "../src/repositories/settingsRepository.ts";
import tagRepository from "../src/repositories/tagRepository.ts";
import {
  __clearCategoryOutlierCacheForTests,
  detectCategoryOutliers,
} from "../src/services/categoryOutlierService.ts";
import { resolveCategoryIdByName } from "../src/services/categoryService.ts";
import { findRecipientClusters } from "../src/services/recipientClusterService.ts";
import {
  createPattern,
  listPatternsForRecipient,
  loadActivePatterns,
  previewPatternMatches,
  updatePattern,
} from "../src/services/recipientPatternService.ts";
import { resolveRecipientIdByName } from "../src/services/recipientService.ts";

const pool = getTestPool();
const SUFFIX = `RC${process.pid}`;
const SETTING_KEY = `vision_test_catalog_${SUFFIX}`;
const created = {
  categoryIds: [] as number[],
  recipientIds: [] as number[],
  tagIds: [] as number[],
  chartIds: [] as number[],
  accountIds: [] as number[],
  transactionIds: [] as number[],
};

describe.skipIf(!hasTestDatabase())(
  "catalog row contracts against PostgreSQL",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180000);

    afterAll(async () => {
      try {
        const db = pool!;
        await db.query("DELETE FROM transactions WHERE id = ANY($1)", [
          created.transactionIds,
        ]);
        await db.query("DELETE FROM accounts WHERE id = ANY($1)", [
          created.accountIds,
        ]);
        await db.query("DELETE FROM saved_charts WHERE id = ANY($1)", [
          created.chartIds,
        ]);
        await db.query("DELETE FROM tags WHERE id = ANY($1)", [created.tagIds]);
        await db.query("DELETE FROM user_settings WHERE key = $1", [
          SETTING_KEY,
        ]);
        await db.query(
          "UPDATE recipients SET primary_recipient_id = NULL WHERE id = ANY($1)",
          [created.recipientIds],
        );
        await db.query(
          "DELETE FROM recipient_bank_accounts WHERE recipient_id = ANY($1)",
          [created.recipientIds],
        );
        await db.query("DELETE FROM recipients WHERE id = ANY($1)", [
          created.recipientIds,
        ]);
        await db.query(
          "DELETE FROM category_merge_aliases WHERE target_category_id = ANY($1)",
          [created.categoryIds],
        );
        await db.query(
          "DELETE FROM category_root_aliases WHERE target_category_id = ANY($1)",
          [created.categoryIds],
        );
        // Children before parents (the self-reference is restrictive).
        for (const id of [...created.categoryIds].reverse()) {
          await db.query("DELETE FROM categories WHERE id = $1", [id]);
        }
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

    it("checks the flat category and category-service reads", async () => {
      const general = `CATG${SUFFIX}`;
      const first = await categoryRepository.createOrGet({
        general,
        detail: "ONE",
        description: "first",
      });
      expect(first.created).toBe(true);
      const one = first.category!;
      created.categoryIds.push(one.id);
      expect(one.category_name).toBe(`${general}:ONE`);
      expect(one.created_at).toBeInstanceOf(Date);

      const again = await categoryRepository.createOrGet({
        general,
        detail: "ONE",
      });
      expect(again).toMatchObject({ created: false, category: { id: one.id } });

      const second = await categoryRepository.createOrGet({
        general,
        detail: "TWO",
      });
      created.categoryIds.push(second.category!.id);

      const listed = await categoryRepository.getAll({ general, active: true });
      expect(listed.map((row) => row.id)).toEqual([
        one.id,
        second.category!.id,
      ]);
      expect(await categoryRepository.getCount({ general })).toBe(2);
      expect(
        (await categoryRepository.getActiveByIds([one.id])).map((r) => r.id),
      ).toEqual([one.id]);
      expect(
        (await categoryRepository.getByGeneralDetail(general, "ONE"))?.id,
      ).toBe(one.id);
      const updated = await categoryRepository.update(one.id, {
        description: "updated",
      });
      expect(updated?.description).toBe("updated");

      expect(await resolveCategoryIdByName(`${general}:ONE`)).toBe(one.id);

      // Merging a legacy category leaves a (general, detail) redirect, which
      // both createOrGet's alias lookup and the legacy resolver follow.
      await mergeCategoryNodes(second.category!.id, one.id);
      created.categoryIds.splice(
        created.categoryIds.indexOf(second.category!.id),
        1,
      );
      const redirected = await categoryRepository.createOrGet({
        general,
        detail: "TWO",
      });
      expect(redirected).toMatchObject({
        created: false,
        category: { id: one.id },
      });
      // No category has the TWO path any more: the legacy branch resolves it.
      expect(await resolveCategoryIdByName(`${general}:TWO`)).toBe(one.id);
    });

    it("checks the category hierarchy reads", async () => {
      const root = await createCategoryNode({ name: `ROOT${SUFFIX}` });
      created.categoryIds.push(root!.id);
      const child = await createCategoryNode({
        name: "CHILD",
        parentId: root!.id,
        description: "leaf",
      });
      created.categoryIds.push(child!.id);
      const sibling = await createCategoryNode({
        name: "SIBLING",
        parentId: root!.id,
      });
      created.categoryIds.push(sibling!.id);

      expect(child).toMatchObject({
        parentId: root!.id,
        pathIds: [root!.id, child!.id],
        depth: 2,
      });
      const nodes = await listCategoryNodes();
      expect(nodes.some((node) => node.id === child!.id)).toBe(true);
      expect((await getCategoryNode(child!.id))?.category_name).toBe(
        `ROOT${SUFFIX}:CHILD`,
      );

      const renamed = await updateCategoryNode(child!.id, { name: "LEAF" });
      expect(renamed?.path).toEqual([`ROOT${SUFFIX}`, "LEAF"]);

      const merged = await mergeCategoryNodes(sibling!.id, child!.id);
      expect(merged?.id).toBe(child!.id);
      created.categoryIds.splice(created.categoryIds.indexOf(sibling!.id), 1);

      expect(await deleteCategoryNode(child!.id)).toBe(true);
      created.categoryIds.splice(created.categoryIds.indexOf(child!.id), 1);
    });

    it("checks the recipient repository and service reads", async () => {
      const name = `ZZCLUSTERPAYEE ${SUFFIX} ONE`;
      const first = await recipientRepository.createOrGet({ name });
      expect(first.created).toBe(true);
      const one = first.recipient!;
      created.recipientIds.push(one.id);
      expect(one.alias_count).toBe(0);
      expect((await recipientRepository.createOrGet({ name })).created).toBe(
        false,
      );

      const two = (
        await recipientRepository.createOrGet({
          name: `ZZCLUSTERPAYEE ${SUFFIX} TWO`,
        })
      ).recipient!;
      created.recipientIds.push(two.id);

      const page = await recipientRepository.getAll({
        search: `ZZCLUSTERPAYEE ${SUFFIX}`,
        limit: 10,
      });
      expect(page.map((row) => row.id)).toEqual([one.id, two.id]);
      expect(
        await recipientRepository.getCount({
          search: `ZZCLUSTERPAYEE ${SUFFIX}`,
        }),
      ).toBe(2);
      expect((await recipientRepository.getByName(name))?.id).toBe(one.id);
      expect(await resolveRecipientIdByName(name)).toBe(one.id);

      const clusters = await findRecipientClusters();
      expect(
        clusters.some((cluster) => cluster.recipientIds.includes(one.id)),
      ).toBe(true);

      const renamed = await recipientRepository.update(one.id, {
        notes: "checked",
      });
      expect(renamed?.notes).toBe("checked");

      const systemId = await recipientRepository.getOrCreateSystemId();
      expect(await recipientRepository.getOrCreateSystemId()).toBe(systemId);

      await withTransaction(async () => {
        const locked = await recipientRepository.lockByIdsForMerge([
          one.id,
          two.id,
        ]);
        expect(locked).toHaveLength(2);
        expect(
          await recipientRepository.flagAliasesOf(one.id, [two.id]),
        ).toEqual([two.id]);
      });
      const aliases = await recipientRepository.getAliases(one.id);
      expect(aliases.map((row) => row.id)).toEqual([two.id]);
      expect((await recipientRepository.getById(one.id))?.alias_count).toBe(1);
      const roots = await recipientRepository.getClusterRootMap([
        one.id,
        two.id,
      ]);
      expect(roots.get(two.id)).toBe(one.id);
      expect(await recipientRepository.unmergeRecipient(two.id)).toBe(true);
    });

    it("checks the recipient bank account and pattern reads", async () => {
      const recipient = (
        await recipientRepository.createOrGet({ name: `IBAN OWNER ${SUFFIX}` })
      ).recipient!;
      created.recipientIds.push(recipient.id);
      const iban = `BE00${process.pid}`.slice(0, 34);

      const made = await recipientBankAccountRepository.createOrGet({
        recipientId: recipient.id,
        accountNumber: iban,
      });
      expect(made).toMatchObject({
        created: true,
        bankAccount: { is_primary: true },
      });
      const enriched = await recipientBankAccountRepository.createOrGet({
        recipientId: recipient.id,
        accountNumber: iban,
        bankName: "Test Bank",
      });
      expect(enriched).toMatchObject({
        created: false,
        bankAccount: { bank_name: "Test Bank" },
      });
      const id = made.bankAccount!.id;
      expect(
        (await recipientBankAccountRepository.getByRecipientId(recipient.id))
          .length,
      ).toBe(1);
      expect(
        (await recipientBankAccountRepository.getPrimaryAccount(recipient.id))
          ?.id,
      ).toBe(id);
      expect(
        (await recipientBankAccountRepository.update(id, { address: "Here" }))
          ?.address,
      ).toBe("Here");

      const { id: patternId } = await createPattern({
        recipientId: recipient.id,
        pattern: `IBAN OWNER ${SUFFIX}`,
      });
      const active = await loadActivePatterns();
      expect(active.find((row) => row.id === patternId)?.updated_at).toEqual(
        expect.any(String),
      );
      await updatePattern(patternId, { case_sensitive: true });
      const listed = await listPatternsForRecipient(recipient.id);
      expect(listed).toMatchObject([{ id: patternId, case_sensitive: true }]);
      const literal = await previewPatternMatches({
        pattern: `IBAN OWNER ${SUFFIX}`,
        pattern_kind: "literal_prefix",
        case_sensitive: false,
      });
      expect(literal.recipientIds).toContain(recipient.id);
      const regex = await previewPatternMatches({
        pattern: `^IBAN OWNER ${SUFFIX}$`,
        pattern_kind: "regex",
        case_sensitive: false,
      });
      expect(regex.recipientIds).toContain(recipient.id);
    });

    it("checks the tag, settings and saved chart reads", async () => {
      const slug = `rc-${process.pid}`;
      const { tag, reactivated } = await tagRepository.findOrCreateBySlug(
        slug,
        "#123456",
      );
      created.tagIds.push(tag.id);
      expect(reactivated).toBe(false);
      expect((await tagRepository.getAll()).some((t) => t.id === tag.id)).toBe(
        true,
      );
      expect(await tagRepository.getCount()).toBeGreaterThan(0);
      expect((await tagRepository.getById(tag.id))?.slug).toBe(slug);
      expect((await tagRepository.getBySlug(slug))?.id).toBe(tag.id);
      expect(await tagRepository.getManyBySlugs([slug])).toHaveLength(1);
      expect((await tagRepository.update(tag.id, { color: null }))?.color).toBe(
        null,
      );
      expect((await tagRepository.softDelete(tag.id))?.is_active).toBe(false);
      expect((await tagRepository.findOrCreateBySlug(slug)).reactivated).toBe(
        true,
      );
      expect(await tagRepository.countTransactionReferences(tag.id)).toBe(0);

      await settingsRepository.set(SETTING_KEY, { nested: [1, "two", null] });
      expect(await settingsRepository.get(SETTING_KEY)).toEqual({
        nested: [1, "two", null],
      });
      expect((await settingsRepository.getAll())[SETTING_KEY]).toBeDefined();
      const baselines = await settingsRepository.getAllWithBaselines();
      expect(baselines.expected[SETTING_KEY]).toMatchObject({ exists: true });
      expect(
        (await settingsRepository.getRecord(SETTING_KEY)).expected,
      ).toEqual({ exists: true, value: { nested: [1, "two", null] } });
      await settingsRepository.set(SETTING_KEY, null);
      expect(await settingsRepository.getRecord(SETTING_KEY)).toEqual({
        value: null,
        expected: { exists: true, value: null },
      });

      const chart = await savedChartsRepository.create({
        name: `Chart ${SUFFIX}`,
        chartType: "bar",
        categoryIds: [],
        tagIds: [tag.id],
        chartVariant: "default",
        timeBucket: "monthly",
        dateRangeStart: "2026-01-01",
      });
      created.chartIds.push(chart!.id);
      expect(chart).toMatchObject({
        tag_ids: [tag.id],
        date_range_start: "2026-01-01",
        date_range_end: null,
      });
      expect(
        (await savedChartsRepository.getAll()).some((c) => c.id === chart!.id),
      ).toBe(true);
      expect(await savedChartsRepository.getCount()).toBeGreaterThan(0);
      expect(
        (await savedChartsRepository.update(chart!.id, { name: "Renamed" }))
          ?.name,
      ).toBe("Renamed");
    });

    it("checks the attachment and category outlier reads", async () => {
      const db = pool!;
      const category = (
        await categoryRepository.createOrGet({
          general: `OUTL${SUFFIX}`,
          detail: "SPEND",
        })
      ).category!;
      created.categoryIds.push(category.id);
      const recipient = (
        await recipientRepository.createOrGet({ name: `SHOP ${SUFFIX}` })
      ).recipient!;
      created.recipientIds.push(recipient.id);
      const account = await db.query<{ id: number }>(
        "INSERT INTO accounts (name, display_name) VALUES ($1, $1) RETURNING id",
        [`Account ${SUFFIX}`],
      );
      const accountId = account.rows[0]!.id;
      created.accountIds.push(accountId);
      const tx = await db.query<{ id: number }>(
        `INSERT INTO transactions (date, amount, currency, recipient_id, category_id, account_id)
         VALUES (CURRENT_DATE, -12.34, 'EUR', $1, $2, $3) RETURNING id`,
        [recipient.id, category.id, accountId],
      );
      const transactionId = tx.rows[0]!.id;
      created.transactionIds.push(transactionId);

      const attachment = await attachmentModule.create({
        transaction_id: transactionId,
        filename: "receipt.pdf",
        stored_path: `${transactionId}/receipt.pdf`,
        mime_type: "application/pdf",
        size_bytes: 1234,
      });
      expect(attachment).toMatchObject({
        transaction_id: transactionId,
        size_bytes: 1234,
        id: expect.any(String),
      });
      expect(
        await attachmentModule.listByTransaction(transactionId),
      ).toHaveLength(1);
      expect(await attachmentModule.countByTransaction(transactionId)).toBe(1);
      expect(
        await attachmentModule.listPathsByTransactionIds([transactionId]),
      ).toEqual([`${transactionId}/receipt.pdf`]);
      expect((await attachmentModule.findById(attachment.id))?.filename).toBe(
        "receipt.pdf",
      );

      __clearCategoryOutlierCacheForTests();
      await expect(detectCategoryOutliers()).resolves.toEqual(
        expect.any(Array),
      );
    });
  },
);
