import { Router } from "express";
import type { ExpressRequest } from "../types/express.ts";
import { z } from "zod";
import {
  aiInvestigationRequestSchema,
  aiInvestigationScopeSchema,
} from "@vision/types/aiResearch";
import { NotFoundError } from "../middleware/errorHandler.ts";
import { parseInput } from "../lib/zodInput.ts";
import {
  createInvestigation,
  listInvestigations,
  getInvestigation,
  cancelInvestigation,
  deleteInvestigation,
  resumeInvestigation,
} from "../services/aiInvestigationService.ts";
const router = Router();
const uuid = z.string().uuid();
const resumeInvestigationSchema = z.strictObject({
  clarification: z.string().min(1).max(1000).optional(),
  scope: aiInvestigationScopeSchema.optional(),
});
function id(req: ExpressRequest): string {
  return parseInput(uuid, req.params.id);
}
router.get("/investigations", async (_req, res) => {
  const items = await listInvestigations();
  res.ok({ items, total: items.length });
});
router.post("/investigations", async (req, res) => {
  const request = parseInput(aiInvestigationRequestSchema, req.body);
  const job = await createInvestigation(request);
  res.status(202);
  res.ok(job);
});
router.get("/investigations/:id", async (req, res) => {
  const job = await getInvestigation(id(req));
  if (!job) throw new NotFoundError("Investigation not found");
  res.ok(job);
});
router.post("/investigations/:id/resume", async (req, res) => {
  const body = parseInput(resumeInvestigationSchema, req.body ?? {});
  const job = await resumeInvestigation(
    id(req),
    body.clarification,
    body.scope,
  );
  if (!job) throw new NotFoundError("Investigation not found");
  res.status(202);
  res.ok(job);
});
router.post("/investigations/:id/cancel", async (req, res) => {
  const job = await cancelInvestigation(id(req));
  if (!job) throw new NotFoundError("Investigation is not active");
  res.ok(job);
});
router.delete("/investigations/:id", async (req, res) => {
  if (!(await deleteInvestigation(id(req))))
    throw new NotFoundError("Investigation not found");
  res.status(204).end();
});

export default router;
