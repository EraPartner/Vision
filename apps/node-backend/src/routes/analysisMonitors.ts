/** Local analysis and dossier monitor rules, history, and in-app inbox. */

import { Router } from "express";
import { z } from "zod";
import {
  checkAnalysisMonitor,
  createAnalysisMonitor,
  deleteAnalysisMonitor,
  listAnalysisMonitors,
  listMonitorNotifications,
  listMonitorObservations,
  patchAnalysisMonitor,
  readMonitorNotification,
} from "../services/analysisMonitorService.ts";
import { parseInput } from "../lib/zodInput.ts";

const router = Router();

const idParamsSchema = z.object({ id: z.uuid() });

// Number() coercion and bounds match the service's own pagination check.
const pageQuerySchema = z.object({
  limit: z
    .string()
    .pipe(z.coerce.number<string>().int().min(1).max(200))
    .optional(),
  offset: z
    .string()
    .pipe(z.coerce.number<string>().int().min(0).max(1_000_000))
    .optional(),
});

// The service validates the rule shape with its own strict schemas.
const monitorBodySchema = z.record(z.string(), z.unknown());

router.get("/", async (req, res) =>
  res.ok(await listAnalysisMonitors(parseInput(pageQuerySchema, req.query))),
);
router.post("/", async (req, res) =>
  res
    .status(201)
    .ok(await createAnalysisMonitor(parseInput(monitorBodySchema, req.body))),
);
router.get("/notifications", async (req, res) =>
  res.ok(
    await listMonitorNotifications(parseInput(pageQuerySchema, req.query)),
  ),
);
router.post("/notifications/:id/read", async (req, res) => {
  const { id } = parseInput(idParamsSchema, req.params);
  res.ok(await readMonitorNotification(id));
});
router.get("/:id/observations", async (req, res) => {
  const { id } = parseInput(idParamsSchema, req.params);
  const page = parseInput(pageQuerySchema, req.query);
  res.ok(await listMonitorObservations(id, page));
});
router.post("/:id/check", async (req, res) => {
  const { id } = parseInput(idParamsSchema, req.params);
  res.ok(await checkAnalysisMonitor(id));
});
router.patch("/:id", async (req, res) => {
  const { id } = parseInput(idParamsSchema, req.params);
  res.ok(
    await patchAnalysisMonitor(id, parseInput(monitorBodySchema, req.body)),
  );
});
router.delete("/:id", async (req, res) => {
  const { id } = parseInput(idParamsSchema, req.params);
  await deleteAnalysisMonitor(id);
  res.status(204).end();
});

export default router;
