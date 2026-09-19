import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.js";
import { ensureAnalysisRole } from "../src/database/analysisRoleBootstrap.js";
import { closeAnalysisPool } from "../src/services/analysisExecutor.js";
import {
  createSavedAnalysis,
  updateSavedAnalysis,
} from "../src/services/savedAnalysisService.js";
import {
  createResearchDossier,
  updateResearchDossier,
} from "../src/services/researchDossierService.js";
import {
  checkAnalysisMonitor,
  checkDueAnalysisMonitors,
  createAnalysisMonitor,
  listMonitorNotifications,
  listMonitorObservations,
  patchAnalysisMonitor,
} from "../src/services/analysisMonitorService.js";

const content = {
  title: "Monitor fixture",
  workspace: "research",
  question: "What evidence changed?",
  userThesis: "A synthetic thesis",
  assumptions: [],
  openQuestions: [],
  conclusion: "",
  reviewDate: null,
  evidence: [],
  links: { categoryIds: [], investmentIds: [], savedAnalysisIds: [] },
};
const citation = (claim) => ({
  stance: "support",
  origin: "user",
  claim,
  source: {
    title: "Synthetic fixture",
    reference: "section 1",
    sourceDate: "2026-09-19",
    accessedAt: null,
  },
  notes: "",
});

let dossierId;
let monitorId;
let savedAnalysisId;
let recipientId;
let transactionId;

describe.skipIf(!hasTestDatabase())("analysis monitors (real Postgres)", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
    if (process.env.VISION_TEST_DB_ISOLATED === "1") {
      expect(
        (
          await ensureAnalysisRole({
            databaseUrl: process.env.DATABASE_URL,
            analysisUrl: process.env.DATABASE_URL_ANALYSIS,
            migrationsUrl: process.env.DATABASE_URL,
          })
        ).status,
      ).not.toBe("degraded");
    }
  }, 180_000);

  afterEach(async () => {
    if (monitorId)
      await getTestPool().query("DELETE FROM analysis_monitors WHERE id=$1", [
        monitorId,
      ]);
    if (dossierId)
      await getTestPool().query("DELETE FROM research_dossiers WHERE id=$1", [
        dossierId,
      ]);
    if (savedAnalysisId)
      await getTestPool().query("DELETE FROM saved_analyses WHERE id=$1", [
        savedAnalysisId,
      ]);
    if (transactionId)
      await getTestPool().query("DELETE FROM transactions WHERE id=$1", [
        transactionId,
      ]);
    if (recipientId)
      await getTestPool().query("DELETE FROM recipients WHERE id=$1", [
        recipientId,
      ]);
    monitorId = undefined;
    dossierId = undefined;
    savedAnalysisId = undefined;
    recipientId = undefined;
    transactionId = undefined;
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
    await closeAnalysisPool();
  });

  it("records a baseline, one evidence episode, pending cooldown, catch-up, and deleted target failure without network work", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Monitor must stay local");
    });
    try {
      const dossier = await createResearchDossier(content);
      dossierId = dossier.id;
      const monitor = await createAnalysisMonitor({
        kind: "dossier-evidence",
        title: "Evidence watch",
        dossierId,
        intervalMinutes: 15,
        cooldownMinutes: 60,
      });
      monitorId = monitor.id;
      expect(monitor).toMatchObject({
        intervalMinutes: 15,
        cooldownMinutes: 60,
      });
      expect(
        await patchAnalysisMonitor(monitorId, {
          title: "Evidence watch updated",
        }),
      ).toMatchObject({
        title: "Evidence watch updated",
        intervalMinutes: 15,
        cooldownMinutes: 60,
      });

      expect((await checkAnalysisMonitor(monitorId)).status).toBe("baseline");
      const edited = await updateResearchDossier(dossierId, {
        ...content,
        evidence: [citation("First"), citation("Second")],
        expectedVersion: 1,
      });
      expect((await checkAnalysisMonitor(monitorId)).status).toBe("triggered");
      expect((await checkAnalysisMonitor(monitorId)).status).toBe("unchanged");
      expect(
        (await listMonitorNotifications({})).items.filter(
          (item) => item.monitorId === monitorId,
        ),
      ).toHaveLength(1);
      await updateResearchDossier(dossierId, {
        ...content,
        evidence: [...edited.evidence].reverse(),
        expectedVersion: 2,
      });
      expect((await checkAnalysisMonitor(monitorId)).status).toBe("unchanged");

      await updateResearchDossier(dossierId, {
        ...content,
        evidence: [...edited.evidence, citation("Third")],
        expectedVersion: 3,
      });
      expect((await checkAnalysisMonitor(monitorId)).status).toBe(
        "cooldown-pending",
      );
      const aged = await getTestPool().query(
        `UPDATE analysis_monitors SET last_notified_at=now()-interval '2 hours',
           next_due_at=now()-interval '1 hour' WHERE id=$1
         RETURNING cooldown_minutes,last_notified_at,
           extract(epoch FROM (now()-last_notified_at))::int AS age_seconds`,
        [monitorId],
      );
      expect(aged.rowCount).toBe(1);
      expect(aged.rows[0].cooldown_minutes).toBe(60);
      expect(aged.rows[0].age_seconds).toBeGreaterThan(3600);
      expect(
        Date.now() - new Date(aged.rows[0].last_notified_at).getTime(),
      ).toBeGreaterThan(3_600_000);
      expect(await checkDueAnalysisMonitors()).toBe(1);
      const afterCatchUp = (
        await getTestPool().query(
          "SELECT last_status,pending_signature,lease_token FROM analysis_monitors WHERE id=$1",
          [monitorId],
        )
      ).rows[0];
      expect(afterCatchUp).toMatchObject({
        last_status: "triggered",
        pending_signature: null,
        lease_token: null,
      });
      expect(
        (await listMonitorObservations(monitorId, {})).items[0].status,
      ).toBe("triggered");
      expect(
        (await listMonitorNotifications({})).items.filter(
          (item) => item.monitorId === monitorId,
        ),
      ).toHaveLength(2);

      await getTestPool().query("DELETE FROM research_dossiers WHERE id=$1", [
        dossierId,
      ]);
      dossierId = undefined;
      const failed = await checkAnalysisMonitor(monitorId);
      expect(failed).toMatchObject({
        status: "failed",
        reasonCode: "dossier-deleted",
        coverage: { status: "unknown" },
      });
      expect((await listMonitorObservations(monitorId, {})).total).toBe(7);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.skipIf(process.env.VISION_TEST_DB_ISOLATED !== "1")(
    "uses the exact completed saved-analysis run for a numeric crossing and deduplicates the episode",
    async () => {
      const marker = "vision-monitor-synthetic-fixture";
      const analysis = await createSavedAnalysis({
        name: "Synthetic transaction count",
        workspace: "budgeting",
        querySpec: {
          mode: "sql",
          sql: `SELECT count(*)::numeric AS amount FROM vision_analysis.transactions_v1 WHERE memo = '${marker}'`,
          datasetIds: ["transactions"],
          columns: [
            { id: "amount", label: "Count", type: "decimal", nullable: false },
          ],
        },
        parameters: {},
      });
      savedAnalysisId = analysis.id;
      const monitor = await createAnalysisMonitor({
        kind: "analysis-threshold",
        title: "Count crossing",
        savedAnalysisId,
        fieldId: "amount",
        operator: "above",
        threshold: "0.00",
        intervalMinutes: 15,
        cooldownMinutes: 60,
      });
      monitorId = monitor.id;
      const baseline = await checkAnalysisMonitor(monitorId);
      expect(baseline).toMatchObject({
        status: "baseline",
        currentValue: "0",
        analysisRunStatus: "completed",
        analysisWindow: { kind: "page", returnedRows: 1, hasMore: false },
      });
      expect(baseline.analysisRunId).toBeTruthy();

      recipientId = (
        await getTestPool().query(
          "INSERT INTO recipients (name,normalized_name) VALUES ($1,$2) RETURNING id",
          ["Monitor Fixture", "monitor fixture"],
        )
      ).rows[0].id;
      transactionId = (
        await getTestPool().query(
          `INSERT INTO transactions
      (date,amount,currency,recipient_id,bank_account,is_active,is_transfer,memo)
      VALUES ('2026-09-19',1,'EUR',$1,NULL,true,false,$2) RETURNING id`,
          [recipientId, marker],
        )
      ).rows[0].id;

      const crossed = await checkAnalysisMonitor(monitorId);
      expect(crossed).toMatchObject({
        status: "triggered",
        previousValue: "0",
        currentValue: "1",
        reasonCode: "threshold-crossed",
        analysisRunStatus: "completed",
      });
      expect(crossed.analysisRunId).not.toBe(baseline.analysisRunId);
      expect((await checkAnalysisMonitor(monitorId)).status).toBe("unchanged");
      expect(
        (await listMonitorNotifications({})).items.filter(
          (item) => item.monitorId === monitorId,
        ),
      ).toHaveLength(1);
      const columns = [
        { id: "amount", label: "Count", type: "decimal", nullable: false },
      ];
      await updateSavedAnalysis(savedAnalysisId, {
        expectedVersion: 1,
        querySpec: {
          mode: "sql",
          sql: `SELECT amount::numeric AS amount FROM vision_analysis.transactions_v1 WHERE memo = '${marker}' UNION ALL SELECT 2::numeric AS amount`,
          datasetIds: ["transactions"],
          columns,
        },
      });
      const partial = await checkAnalysisMonitor(monitorId);
      expect(partial).toMatchObject({
        status: "partial",
        reasonCode: "analysis-window-incomplete",
        analysisRunStatus: "completed",
      });
      expect(
        (await listMonitorNotifications({})).items.filter(
          (item) => item.monitorId === monitorId,
        ),
      ).toHaveLength(1);
      await updateSavedAnalysis(savedAnalysisId, {
        expectedVersion: 2,
        querySpec: {
          mode: "sql",
          sql: `SELECT count(*)::numeric AS amount FROM vision_analysis.transactions_v1 WHERE memo = '${marker}'`,
          datasetIds: ["transactions"],
          columns,
        },
      });
      expect((await checkAnalysisMonitor(monitorId)).status).toBe("baseline");
      expect(
        (await listMonitorNotifications({})).items.filter(
          (item) => item.monitorId === monitorId,
        ),
      ).toHaveLength(1);
    },
  );
});
