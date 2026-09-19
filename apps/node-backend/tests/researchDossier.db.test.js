import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  deleteAllCategoryFixtures,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.js";
import {
  createResearchDossier,
  deleteResearchDossier,
  exportResearchDossier,
  getResearchDossier,
  listResearchDossiers,
  listResearchDossierVersions,
  restoreResearchDossier,
  updateResearchDossier,
} from "../src/services/researchDossierService.js";

const base = {
  title: "Research lifecycle fixture",
  workspace: "budgeting",
  question: "Does this category still matter?",
  userThesis: "It might",
  assumptions: ["This is a synthetic fixture"],
  openQuestions: [],
  conclusion: "Initial conclusion",
  reviewDate: "2026-10-01",
  evidence: [
    {
      stance: "support",
      origin: "user",
      claim: "A synthetic observation",
      source: {
        title: "Fixture note",
        reference: "section 1",
        sourceDate: "2026-09-19",
        accessedAt: null,
      },
      notes: "",
    },
  ],
};

let dossierId;

describe.skipIf(!hasTestDatabase())("research dossiers (real Postgres)", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
  }, 180_000);

  afterEach(async () => {
    if (dossierId) {
      await getTestPool().query("DELETE FROM research_dossiers WHERE id=$1", [
        dossierId,
      ]);
      dossierId = undefined;
    }
    await deleteAllCategoryFixtures(getTestPool());
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("versions edits and restores, then retains a deleted link snapshot", async () => {
    const { rows } = await getTestPool().query(
      "INSERT INTO categories (general, detail) VALUES ($1,$2) RETURNING id",
      ["DOSSIER_TEST", "LEAF"],
    );
    const categoryId = rows[0].id;
    const created = await createResearchDossier({
      ...base,
      links: {
        categoryIds: [categoryId],
        investmentIds: [],
        savedAnalysisIds: [],
      },
    });
    dossierId = created.id;
    expect(created).toMatchObject({ version: 1, conclusion: base.conclusion });
    expect(created.evidence[0].id).toBeTruthy();
    const listed = await listResearchDossiers();
    expect(listed.items.find((item) => item.id === dossierId)).toMatchObject({
      id: dossierId,
      title: base.title,
      question: base.question,
    });
    expect(
      listed.items.find((item) => item.id === dossierId),
    ).not.toHaveProperty("evidence");

    const edited = await updateResearchDossier(created.id, {
      ...base,
      evidence: created.evidence,
      links: created.links,
      conclusion: "Revised conclusion",
      expectedVersion: 1,
    });
    expect(edited.version).toBe(2);
    expect((await listResearchDossierVersions(created.id)).items).toEqual([
      expect.objectContaining({ version: 2 }),
      expect.objectContaining({ version: 1 }),
    ]);

    const restored = await restoreResearchDossier(created.id, {
      version: 1,
      expectedVersion: 2,
    });
    expect(restored).toMatchObject({ version: 3, conclusion: base.conclusion });
    expect(
      (await exportResearchDossier(created.id)).dossiers[0].versions,
    ).toHaveLength(3);

    await getTestPool().query("DELETE FROM categories WHERE id=$1", [
      categoryId,
    ]);
    const deletedLink = await getResearchDossier(created.id);
    expect(deletedLink.links.categoryIds).toEqual([]);
    expect(deletedLink.linkDetails).toEqual([
      expect.objectContaining({
        kind: "category",
        historicalId: String(categoryId),
        status: "deleted",
      }),
    ]);
    const afterDeletion = await updateResearchDossier(created.id, {
      ...base,
      evidence: deletedLink.evidence,
      links: deletedLink.links,
      expectedVersion: 3,
    });
    expect(afterDeletion.linkDetails[0].status).toBe("deleted");
    await deleteResearchDossier(created.id);
    dossierId = undefined;
    await expect(getResearchDossier(created.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});
