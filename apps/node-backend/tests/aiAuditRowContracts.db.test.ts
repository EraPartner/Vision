/**
 * Real-Postgres coverage for the checked reads (ADR-193) of the AI
 * repositories, saved-analysis versions, monitor notifications and the admin database stats. Each call
 * goes through its row schema, so a schema that is wrong for what pg really
 * returns fails here with a RowContractError.
 */
import { bodyAt } from "./helpers/responseBody.ts";
import { randomUUID } from "node:crypto";
import type { AiInvestigationRequest } from "@vision/types/aiResearch";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { routeAgent } from "./helpers/routeApp.ts";
import { closePool } from "../src/database/connection.ts";
import { ensureAnalysisRole } from "../src/database/analysisRoleBootstrap.ts";
import {
  cancelAnalysisQuery,
  closeAnalysisPool,
  executeAnalysisSql,
} from "../src/services/analysisExecutor.ts";
import aiChatRepository from "../src/repositories/aiChatRepository.ts";
import * as investigations from "../src/repositories/aiInvestigationRepository.ts";
import * as documents from "../src/repositories/aiResearchDocumentRepository.ts";
import {
  createSavedAnalysis,
  deleteSavedAnalysis,
  getSavedAnalysis,
  listSavedAnalyses,
  listSavedAnalysisVersions,
  restoreSavedAnalysisVersion,
  runSavedAnalysis,
  updateSavedAnalysis,
} from "../src/services/savedAnalysisService.ts";
import {
  createResearchDossier,
  exportResearchDossiers,
  updateResearchDossier,
} from "../src/services/researchDossierService.ts";
import {
  checkAnalysisMonitor,
  createAnalysisMonitor,
  deleteAnalysisMonitor,
  listAnalysisMonitors,
  listMonitorNotifications,
  readMonitorNotification,
} from "../src/services/analysisMonitorService.ts";
import adminRouter from "../src/routes/admin.ts";

const HASH = "b".repeat(64);

const cleanup: { sql: string; params: unknown[] }[] = [];
function onCleanup(sql: string, ...params: unknown[]) {
  cleanup.unshift({ sql, params });
}

describe.skipIf(!hasTestDatabase())(
  "AI and analysis row contracts (real Postgres)",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
      if (process.env.VISION_TEST_DB_ISOLATED === "1") {
        expect(
          (
            await ensureAnalysisRole({
              databaseUrl: process.env.DATABASE_URL!,
              analysisUrl: process.env.DATABASE_URL_ANALYSIS,
              migrationsUrl: process.env.DATABASE_URL,
            })
          ).status,
        ).not.toBe("degraded");
      }
    }, 180_000);

    afterEach(async () => {
      for (const { sql, params } of cleanup.splice(0))
        await getTestPool()!.query(sql, params);
    });

    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
      await closeAnalysisPool();
    });

    it("reads AI chat conversations and messages", async () => {
      const conversation = await aiChatRepository.createConversation({
        title: "Synthetic chat",
        model: "synthetic-model",
      });
      onCleanup("DELETE FROM ai_conversations WHERE id=$1", conversation.id);
      expect(conversation.createdAt).toBeInstanceOf(Date);

      const page = await aiChatRepository.listConversations({
        limit: 50,
        offset: 0,
      });
      expect(page.total).toBeGreaterThanOrEqual(1);
      expect(page.items.map((item) => item.id)).toContain(conversation.id);
      expect(
        await aiChatRepository.getConversation(conversation.id),
      ).toMatchObject({ id: conversation.id });
      expect(
        await aiChatRepository.renameConversation(conversation.id, "Renamed"),
      ).toMatchObject({ title: "Renamed" });
      expect(
        await aiChatRepository.updateConversationModel(
          conversation.id,
          "other-model",
        ),
      ).toMatchObject({ model: "other-model" });

      await aiChatRepository.appendMessage({
        conversationId: conversation.id,
        role: "user",
        content: "Synthetic question",
      });
      const tool = await aiChatRepository.appendMessage({
        conversationId: conversation.id,
        role: "tool",
        toolName: "synthetic_tool",
        toolArgs: { limit: 1 },
        toolResult: { ok: true, data: [] },
      });
      expect(tool).toMatchObject({
        role: "tool",
        content: null,
        toolArgs: { limit: 1 },
        status: "complete",
      });
      const messages = await aiChatRepository.getMessages(conversation.id);
      expect(messages.map((message) => message.role)).toEqual(["user", "tool"]);

      expect(await aiChatRepository.deleteConversation(conversation.id)).toBe(
        true,
      );
      expect(await aiChatRepository.getConversation(conversation.id)).toBe(
        null,
      );
    });

    it("reads investigation jobs and steps", async () => {
      const request = {
        question: "Synthetic investigation",
        route: "local",
        model: null,
        depth: "quick",
        language: "en",
        scope: { months: 3 },
        researchMode: "local-only",
      } as unknown as AiInvestigationRequest;
      const job = await investigations.createJob(request);
      onCleanup("DELETE FROM ai_investigation_jobs WHERE id=$1", job.id);
      expect(job).toMatchObject({ state: "queued", plan: null });

      expect((await investigations.listJobs()).map((row) => row.id)).toContain(
        job.id,
      );
      expect(
        (await investigations.listRecoverableJobs()).map((row) => row.id),
      ).toContain(job.id);
      const plan = { steps: [{ id: "gather", tool: "synthetic" }] };
      expect(await investigations.setWaiting(job.id, plan)).toMatchObject({
        state: "waiting",
        plan,
      });
      expect(
        await investigations.resolveWaiting(job.id, "Clarified", {
          months: 6,
        }),
      ).toMatchObject({ state: "queued", plan: null });
      expect(await investigations.setPlan(job.id, plan)).toMatchObject({
        state: "running",
      });

      await investigations.seedSteps(job.id, [{ id: "gather" }]);
      const started = await investigations.startStep(job.id, "gather");
      expect(started).toMatchObject({ step_id: "gather", attempt: 1 });
      await investigations.finishStep(job.id, "gather", { rows: [] });
      expect(await investigations.getSteps(job.id)).toEqual([
        expect.objectContaining({ stepId: "gather", state: "completed" }),
      ]);
      expect(await investigations.startStep(job.id, "gather")).toBe(null);

      expect(
        await investigations.setProviderResult(job.id, { summary: "x" }),
      ).toEqual({ id: job.id });
      expect(await investigations.clearProviderResult(job.id)).toEqual({
        id: job.id,
      });
      expect(await investigations.getJob(job.id)).toMatchObject({
        checkpoint: {},
      });
      expect(
        await investigations.finishJob(job.id, "completed", { answer: "x" }),
      ).toMatchObject({ state: "completed", result: { answer: "x" } });
      expect(await investigations.requestCancel(job.id)).toBe(null);
    });

    it("reads research documents and passages", async () => {
      const sourceName = `synthetic-${randomUUID()}.txt`;
      const created = await documents.createDocument(
        {
          title: "Synthetic research",
          sourceName,
          mediaType: "text/plain",
          contentSha256: HASH,
          extractionStatus: "ready",
        },
        [
          {
            ordinal: 0,
            pageNumber: 1,
            section: "Intro",
            content: "zyxwvutsynthetic passage about inflation",
            embedding: { model: "synthetic", vector: [0.5, 0.25] },
          },
        ],
      );
      onCleanup("DELETE FROM ai_research_documents WHERE id=$1", created.id);
      expect(created).toMatchObject({ version: 1, extractionError: null });
      expect(
        await documents.createDocument(
          {
            title: "Synthetic research",
            sourceName,
            mediaType: "text/plain",
            contentSha256: HASH,
            extractionStatus: "ready",
          },
          [],
        ),
      ).toMatchObject({ id: created.id });
      expect(await documents.getDocument(created.id)).toMatchObject({
        id: created.id,
      });
      expect((await documents.listDocuments()).map((row) => row.id)).toContain(
        created.id,
      );
      const [hit] = await documents.keywordSearch("zyxwvutsynthetic", 5);
      expect(hit).toMatchObject({ documentId: created.id, pageNumber: 1 });
      expect(typeof hit!.score).toBe("number");
      expect(
        (await documents.semanticCandidates(500)).find(
          (row) => row.documentId === created.id,
        ),
      ).toMatchObject({ embedding: { model: "synthetic" } });
    });

    it("reads monitor lists and marks a notification read", async () => {
      const content = {
        title: "Row contract monitor",
        workspace: "research",
        question: "What changed?",
        userThesis: "Synthetic",
        assumptions: [],
        openQuestions: [],
        conclusion: "",
        reviewDate: null,
        evidence: [],
        links: { categoryIds: [], investmentIds: [], savedAnalysisIds: [] },
      };
      const dossier = await createResearchDossier(content);
      onCleanup("DELETE FROM research_dossiers WHERE id=$1", dossier.id);
      const monitor = await createAnalysisMonitor({
        kind: "dossier-evidence",
        title: "Row contract watch",
        dossierId: dossier.id,
        intervalMinutes: 15,
        cooldownMinutes: 60,
      });
      onCleanup("DELETE FROM analysis_monitors WHERE id=$1", monitor.id);
      await checkAnalysisMonitor(monitor.id);
      await updateResearchDossier(dossier.id, {
        ...content,
        evidence: [
          {
            stance: "support",
            origin: "user",
            claim: "Synthetic claim",
            source: {
              title: "Synthetic source",
              reference: "p. 1",
              sourceDate: "2026-09-19",
              accessedAt: null,
            },
            notes: "",
          },
        ],
        expectedVersion: 1,
      });
      expect((await checkAnalysisMonitor(monitor.id))!.status).toBe(
        "triggered",
      );

      const monitors = await listAnalysisMonitors({});
      expect(monitors.total).toBeGreaterThanOrEqual(1);
      expect(
        monitors.items.find((item) => item.id === monitor.id),
      ).toMatchObject({ lastObservation: { status: "triggered" } });
      const notifications = await listMonitorNotifications({});
      const notification = notifications.items.find(
        (item) => item.monitorId === monitor.id,
      );
      expect(notifications.unreadCount).toBeGreaterThanOrEqual(1);
      expect(await readMonitorNotification(notification!.id)).toMatchObject({
        id: notification!.id,
        readAt: expect.any(Date),
      });
      expect(
        (await exportResearchDossiers()).dossiers.map((item) => item.id),
      ).toContain(dossier.id);
      await deleteAnalysisMonitor(monitor.id);
    });

    it.skipIf(process.env.VISION_TEST_DB_ISOLATED !== "1")(
      "reads saved analyses through run, versions, restore and delete",
      async () => {
        const querySpec = (sql: string) => ({
          mode: "sql" as const,
          sql,
          datasetIds: ["transactions"],
          columns: [
            { id: "amount", label: "Count", type: "decimal", nullable: false },
          ],
        });
        const analysis = await createSavedAnalysis({
          name: "Row contract analysis",
          workspace: "budgeting",
          querySpec: querySpec(
            "SELECT count(*)::numeric AS amount FROM vision_analysis.transactions_v1 WHERE false",
          ),
          parameters: {},
        });
        const id = analysis!.id;
        onCleanup("DELETE FROM saved_analyses WHERE id=$1", id);
        expect(await runSavedAnalysis(id)).toMatchObject({ id });
        expect(
          (await listSavedAnalyses("budgeting")).map((item) => item.id),
        ).toContain(id);
        expect((await listSavedAnalyses()).map((item) => item.id)).toContain(
          id,
        );
        await updateSavedAnalysis(id, {
          expectedVersion: 1,
          querySpec: querySpec(
            "SELECT 2::numeric AS amount FROM vision_analysis.transactions_v1 WHERE false",
          ),
        });
        const versions = await listSavedAnalysisVersions(id);
        expect(versions.map((version) => version.version)).toEqual([2, 1]);
        expect(versions[0]!.createdAt).toBeInstanceOf(Date);
        expect(await restoreSavedAnalysisVersion(id, 1, 2)).toMatchObject({
          id,
          version: 3,
        });
        expect((await getSavedAnalysis(id))!.version).toBe(3);
        expect(await deleteSavedAnalysis(id)).toBe(true);
      },
    );

    it.skipIf(process.env.VISION_TEST_DB_ISOLATED !== "1")(
      "cancels a running analysis query through pg_cancel_backend",
      async () => {
        const requestId = `row-contracts-${randomUUID()}`;
        const running = executeAnalysisSql({
          requestId,
          // A CPU-bound cross join that would outlast the 5 s statement timeout.
          sql: `WITH s AS (SELECT generate_series(1, 50000) AS n)
                SELECT count(*)::numeric AS amount
                  FROM s AS a CROSS JOIN s AS b
                  LEFT JOIN vision_analysis.transactions_v1 AS t ON false`,
          datasetIds: ["transactions"],
        });
        const outcome = running.then(
          () => "completed",
          (error: { code?: string }) => error.code,
        );
        let cancelled = { cancelled: false } as { cancelled: boolean };
        for (
          let attempt = 0;
          attempt < 100 && !cancelled.cancelled;
          attempt++
        ) {
          cancelled = await cancelAnalysisQuery(requestId);
          if (!cancelled.cancelled)
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(cancelled).toEqual({ cancelled: true });
        expect(await outcome).toBe("57014");
      },
    );

    it("reads the admin database stats and vacuum allowlist", async () => {
      const agent = routeAgent(adminRouter);
      const stats = await agent.get("/database/stats");
      expect(stats.status).toBe(200);
      expect(typeof bodyAt(stats, "data", "db_size")).toBe("string");
      expect(bodyAt(stats, "data", "tables", "length")).toBeGreaterThan(0);
      const rejected = await agent
        .post("/database/vacuum")
        .send({ table: "no_such_table_row_contracts" });
      expect(rejected.status).toBe(400);
    });
  },
);
