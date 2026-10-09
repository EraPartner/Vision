/** Local research dossiers: versioned writes and portable JSON exports. */

import { Router } from "express";
import { z } from "zod";
import { parseInput } from "../lib/zodInput.ts";
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
} from "../services/researchDossierService.ts";

const router = Router();

// Same bounds the service enforces; z.coerce.number() reads the query string
// exactly as the former Number(...) did, so malformed values (`abc`, ``, `1.5`)
// are rejected rather than clamped.
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const dossierIdSchema = z.string().uuid();

// Dossier bodies are validated by the service's own content schemas, which
// answer 400 INVALID_DOSSIER with field paths.
const dossierId = (value: unknown) => parseInput(dossierIdSchema, value);

router.get("/", async (req, res) =>
  res.ok(await listResearchDossiers(parseInput(listQuerySchema, req.query))),
);
router.post("/", async (req, res) => {
  res.status(201).ok(await createResearchDossier(req.body));
});

// Keep this ahead of /:id so the literal path is never parsed as a UUID.
router.get("/export", async (_req, res) =>
  res.ok(await exportResearchDossiers()),
);
router.get("/:id/export", async (req, res) =>
  res.ok(await exportResearchDossier(dossierId(req.params.id))),
);
router.get("/:id/versions", async (req, res) =>
  res.ok(await listResearchDossierVersions(dossierId(req.params.id))),
);
router.post("/:id/restore", async (req, res) =>
  res.ok(await restoreResearchDossier(dossierId(req.params.id), req.body)),
);
router.get("/:id", async (req, res) =>
  res.ok(await getResearchDossier(dossierId(req.params.id))),
);
router.put("/:id", async (req, res) =>
  res.ok(await updateResearchDossier(dossierId(req.params.id), req.body)),
);
router.delete("/:id", async (req, res) => {
  await deleteResearchDossier(dossierId(req.params.id));
  res.status(204).end();
});

export default router;
