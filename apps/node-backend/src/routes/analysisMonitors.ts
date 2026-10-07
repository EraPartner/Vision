/** Local analysis and dossier monitor rules, history, and in-app inbox. */

import { Router } from "express";
import {
  checkAnalysisMonitor,
  createAnalysisMonitor,
  deleteAnalysisMonitor,
  listAnalysisMonitors,
  listMonitorNotifications,
  listMonitorObservations,
  patchAnalysisMonitor,
  readMonitorNotification,
} from "../services/analysisMonitorService.js";

const router = Router();

router.get("/", async (req, res) =>
  res.ok(await listAnalysisMonitors(req.query)),
);
router.post("/", async (req, res) =>
  res.status(201).ok(await createAnalysisMonitor(req.body)),
);
router.get("/notifications", async (req, res) =>
  res.ok(await listMonitorNotifications(req.query)),
);
router.post("/notifications/:id/read", async (req, res) =>
  res.ok(await readMonitorNotification(req.params.id)),
);
router.get("/:id/observations", async (req, res) =>
  res.ok(await listMonitorObservations(req.params.id, req.query)),
);
router.post("/:id/check", async (req, res) =>
  res.ok(await checkAnalysisMonitor(req.params.id)),
);
router.patch("/:id", async (req, res) =>
  res.ok(await patchAnalysisMonitor(req.params.id, req.body)),
);
router.delete("/:id", async (req, res) => {
  await deleteAnalysisMonitor(req.params.id);
  res.status(204).end();
});

export default router;
