/** Local research dossiers: versioned writes and portable JSON exports. */

import { Router } from "express";
import {
  createResearchDossier,
  deleteResearchDossier,
  exportResearchDossier,
  exportResearchDossiers,
  getResearchDossier,
  listResearchDossierVersions,
  listResearchDossiers,
  restoreResearchDossier,
  updateResearchDossier,
} from "../services/researchDossierService.js";

const router = Router();

router.get("/", async (req, res) =>
  res.ok(
    await listResearchDossiers({
      limit: req.query.limit === undefined ? 100 : Number(req.query.limit),
      offset: req.query.offset === undefined ? 0 : Number(req.query.offset),
    }),
  ),
);
router.post("/", async (req, res) => {
  res.status(201).ok(await createResearchDossier(req.body));
});

// Keep this ahead of /:id so the literal path is never parsed as a UUID.
router.get("/export", async (_req, res) =>
  res.ok(await exportResearchDossiers()),
);
router.get("/:id/export", async (req, res) =>
  res.ok(await exportResearchDossier(req.params.id)),
);
router.get("/:id/versions", async (req, res) =>
  res.ok(await listResearchDossierVersions(req.params.id)),
);
router.post("/:id/restore", async (req, res) =>
  res.ok(await restoreResearchDossier(req.params.id, req.body)),
);
router.get("/:id", async (req, res) =>
  res.ok(await getResearchDossier(req.params.id)),
);
router.put("/:id", async (req, res) =>
  res.ok(await updateResearchDossier(req.params.id, req.body)),
);
router.delete("/:id", async (req, res) => {
  await deleteResearchDossier(req.params.id);
  res.status(204).end();
});

export default router;
