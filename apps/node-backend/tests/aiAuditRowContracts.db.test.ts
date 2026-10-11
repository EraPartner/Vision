/**
 * Real-Postgres coverage for the checked reads (ADR-193) of the AI
 * repositories, the audit chain head and checkpoints, saved-analysis
 * versions, monitor notifications and the admin database stats. Each call
 * goes through its row schema, so a schema that is wrong for what pg really
 * returns fails here with a RowContractError.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AiDisclosureGrant,
  AiInvestigationRequest,
} from "@vision/types/aiResearch";
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
import * as disclosure from "../src/repositories/aiDisclosureRepository.ts";
import * as documents from "../src/repositories/aiResearchDocumentRepository.ts";
import * as references from "../src/repositories/aiReferenceRepository.ts";
import {
  appendAuditEvent,
  readAuditHead,
  readAuditSegment,
  recordAuditCheckpoint,
} from "../src/repositories/auditChainRepository.ts";
import { verifyAuditHistory } from "../src/services/auditVerificationService.ts";
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
const STREAM = "test_row_contracts";

const cleanup: { sql: string; params: unknown[] }[] = [];
function onCleanup(sql: string, ...params: unknown[]) {
  cleanup.unshift({ sql, params });
}

describe.skipIf(!hasTestDatabase())(
  "AI, audit and analysis row contracts (real Postgres)",
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

    it("reads investigation jobs, steps and reference scopes", async () => {
      const scopeId = randomUUID();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      await references.createScope({
        id: scopeId,
        expiresAt,
        entries: [
          {
            token: `[[VR1:account:${randomBytes(18).toString("base64url")}]]`,
            referenceType: "account",
            ciphertext: randomBytes(16),
            nonce: randomBytes(12),
            authTag: randomBytes(16),
          },
        ],
      });
      onCleanup("DELETE FROM ai_reference_scopes WHERE id=$1", scopeId);
      const scope = await references.getScope(scopeId);
      expect(scope).toMatchObject({ id: scopeId, jobId: null });
      expect(scope!.entries[0]!.ciphertext).toBeInstanceOf(Buffer);

      const request = {
        question: "Synthetic investigation",
        route: "local",
        model: null,
        depth: "quick",
        language: "en",
        scope: { months: 3 },
        researchMode: "local-only",
        grantId: null,
        referenceScopeId: scopeId,
      } as unknown as AiInvestigationRequest;
      const job = await investigations.createJob(request, expiresAt);
      onCleanup("DELETE FROM ai_investigation_jobs WHERE id=$1", job.id);
      expect(job).toMatchObject({ state: "queued", plan: null });
      expect(await references.getScopeForJob(job.id)).toMatchObject({
        id: scopeId,
        jobId: job.id,
      });

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

    it("reads disclosure grants and records through a reservation", async () => {
      const grant = await disclosure.createGrant({
        route: "openai-api",
        mode: "cloud-plan-public",
        purpose: "Synthetic grant",
        previewHash: HASH,
        allowedFields: ["question"],
        maxRequests: 2,
        maxInputCharacters: 1000,
        maxOutputTokens: 1000,
        maxCostMicros: 1000,
        maxDisclosureUnits: 5,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        retainExactPayload: false,
      } satisfies AiDisclosureGrant);
      onCleanup("DELETE FROM ai_disclosure_grants WHERE id=$1", grant.id);
      expect(grant).toMatchObject({
        max_cost_micros: "1000",
        used_requests: 0,
      });

      const job = await investigations.createJob({
        question: "Synthetic cloud question",
        route: "openai-api",
        model: null,
        depth: "quick",
        language: "en",
        scope: {},
        grantId: grant.id,
      } as unknown as AiInvestigationRequest);
      onCleanup("DELETE FROM ai_investigation_jobs WHERE id=$1", job.id);
      onCleanup(
        "DELETE FROM ai_disclosure_records WHERE grant_id=$1",
        grant.id,
      );

      const record = await disclosure.reserveDisclosure({
        grantId: grant.id,
        jobId: job.id,
        expectedMode: "cloud-plan-public",
        preview: {
          payloadSha256: HASH,
          fieldManifest: ["question"],
          disclosureUnits: ["unit-1"],
          inputCharacters: 10,
          payloadBytes: 10,
        },
        outputTokens: 10,
        costMicros: 10,
        monthlyBudgetMicros: 1_000_000_000,
      });
      expect(record).toMatchObject({
        status: "authorized",
        reserved_cost_micros: "10",
      });
      expect(
        await disclosure.updateDisclosureRecord(record.id, {
          status: "sent",
          providerRequestId: "req-synthetic",
        }),
      ).toMatchObject({ status: "sent" });
      expect(await disclosure.findUncertainDisclosure(job.id)).toEqual({
        id: record.id,
      });
      expect(
        await disclosure.updateDisclosureRecord(record.id, {
          status: "completed",
          inputTokens: 5,
          outputTokens: 5,
          costMicros: 7,
        }),
      ).toMatchObject({ actual_cost_micros: "7" });
      expect(
        (await disclosure.listGrants()).find((row) => row.id === grant.id),
      ).toMatchObject({ used_requests: 1, used_cost_micros: "10" });
      expect((await disclosure.listRecords()).map((row) => row.id)).toContain(
        record.id,
      );

      // A second reservation reads the prior units and the monthly total.
      await disclosure.reserveDisclosure({
        grantId: grant.id,
        jobId: job.id,
        expectedMode: "cloud-plan-public",
        preview: {
          payloadSha256: HASH,
          fieldManifest: ["question"],
          disclosureUnits: ["unit-2"],
          inputCharacters: 10,
          payloadBytes: 10,
        },
        outputTokens: 10,
        costMicros: 10,
        monthlyBudgetMicros: 1_000_000_000,
      });
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

    // Audit history and checkpoints are append-only, so this test leaves its
    // synthetic entries in the disposable test database.
    it("reads the audit chain head, a segment and checkpoint receipts", async () => {
      await appendAuditEvent({ stream: STREAM, event: "first" });
      await appendAuditEvent({ stream: STREAM, event: "second" });
      const head = await readAuditHead();
      expect(head.sequence).toBeGreaterThanOrEqual(2);
      expect(head.updatedAt).toBeInstanceOf(Date);
      const [previous] = await readAuditSegment({
        afterSequence: head.sequence - 2,
        limit: 1,
      });
      expect(previous!.sequence).toBe(head.sequence - 1);

      for (const [sequence, headHash] of [
        [head.sequence, head.hash],
        [previous!.sequence, previous!.hash],
      ] as const) {
        const receipt = {
          sequence,
          headHash,
          anchorKind: STREAM,
          receiptId: randomUUID(),
          receiptHash: HASH,
        };
        const recorded = await recordAuditCheckpoint(receipt);
        expect(recorded.createdAt).toBeInstanceOf(Date);
        // Replaying the same receipt reads the existing checkpoint row.
        expect(await recordAuditCheckpoint(receipt)).toEqual(recorded);
      }
    });

    // The rows below mirror what dbEditor, splitService and the portfolio
    // retag service write; the domain audit tables are append-only too.
    it("verifies chain entries against each linked domain audit row", async () => {
      const pool = getTestPool()!;
      const digest = (values: unknown[]) =>
        createHash("sha256").update(JSON.stringify(values)).digest("hex");
      const occurredAt = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at`;

      const editor = (
        await pool.query(
          `INSERT INTO db_editor_audit (table_name, op, pk_json, before_json, after_json, statement)
           VALUES ('categories', 'update', '{"id": 1}', NULL, '{"detail": "x"}', 'UPDATE synthetic')
           RETURNING id, pk_json::text AS pk_text, before_json::text AS before_text,
                     after_json::text AS after_text, statement, ${occurredAt}`,
        )
      ).rows[0];
      await appendAuditEvent({
        stream: "db_editor",
        event: "update",
        auditRowId: String(editor.id),
        table: "categories",
        occurred_at: editor.occurred_at,
        auditDigest: digest([
          "categories",
          "update",
          editor.pk_text,
          editor.before_text,
          editor.after_text,
          editor.statement,
          editor.occurred_at,
        ]),
      });

      const split = (
        await pool.query(
          `INSERT INTO split_audit (split_id, action, actor, payload)
           VALUES (NULL, 'delete', NULL, '{"amount": "1.00"}')
           RETURNING id, payload::text AS payload_text, ${occurredAt}`,
        )
      ).rows[0];
      await appendAuditEvent({
        stream: "split",
        event: "delete",
        auditRowId: String(split.id),
        splitId: null,
        actor: null,
        occurred_at: split.occurred_at,
        auditDigest: digest([
          null,
          "delete",
          null,
          split.payload_text,
          split.occurred_at,
        ]),
      });

      const retag = (
        await pool.query(
          `INSERT INTO portfolio_retag_audit
             (idempotency_key, request_fingerprint, from_account_id, to_account_id,
              transaction_ids, previous_assignments, selected_count, changed_count)
           VALUES ($1, $2, NULL, 7, '[1]', '[{"transaction_id": 1, "account_id": null}]', 1, 1)
           RETURNING id, ${occurredAt}, idempotency_key, request_fingerprint,
                     from_account_id, to_account_id, transaction_ids,
                     previous_assignments, selected_count, changed_count`,
          [randomUUID(), HASH],
        )
      ).rows[0];
      await appendAuditEvent({
        stream: "portfolio_retag",
        event: "receipt_created",
        receipt_id: String(retag.id),
        occurred_at: retag.occurred_at,
        idempotency_key: retag.idempotency_key,
        request_fingerprint: retag.request_fingerprint,
        from_account_id: retag.from_account_id,
        to_account_id: retag.to_account_id,
        transaction_ids: retag.transaction_ids,
        previous_assignments: retag.previous_assignments,
        selected_count: retag.selected_count,
        changed_count: retag.changed_count,
      });

      // Another suite in the same database may have pruned the chain's
      // prefix; trust that boundary so the walk still reaches these entries.
      const head = await readAuditHead();
      const [earliest] = await readAuditSegment({ afterSequence: 0, limit: 1 });
      const retention =
        earliest && earliest.sequence > 1
          ? {
              through: earliest.sequence - 1,
              hash: earliest.previousHash,
              domainMax: { dbEditor: 0, split: 0, retag: 0 },
              migrationHeads: (
                await pool.query(
                  "SELECT version_num FROM alembic_version ORDER BY version_num",
                )
              ).rows.map((row: { version_num: string }) => row.version_num),
            }
          : undefined;
      expect(
        await verifyAuditHistory({
          trustedCheckpoint: {
            sequence: head.sequence,
            hash: head.hash,
            retention,
          },
        }),
      ).toMatchObject({ status: "verified" });
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
      expect(typeof stats.body.data.db_size).toBe("string");
      expect(stats.body.data.tables.length).toBeGreaterThan(0);
      const rejected = await agent
        .post("/database/vacuum")
        .send({ table: "no_such_table_row_contracts" });
      expect(rejected.status).toBe(400);
    });
  },
);
