import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.js";
import {
  deleteResearchDocument,
  getResearchDocument,
  ingestResearchDocument,
  listResearchDocuments,
  searchResearchDocuments,
} from "../services/aiResearchDocuments.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
const uuid = z.string().uuid();
function documentId(value) {
  const parsed = uuid.safeParse(value);
  if (!parsed.success)
    throw new ValidationError("Invalid research document id");
  return parsed.data;
}

router.get("/", async (_req, res) => {
  const items = await listResearchDocuments();
  res.ok({ items, total: items.length });
});
router.get("/:id", async (req, res) => {
  const document = await getResearchDocument(documentId(req.params.id));
  if (!document) throw new NotFoundError("Research document not found");
  res.ok(document);
});
router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) throw new ValidationError("A file is required");
    const document = await ingestResearchDocument({
      title: req.body.title || req.file.originalname,
      sourceName: req.body.source_name || req.file.originalname,
      mediaType: req.file.mimetype || "application/octet-stream",
      buffer: req.file.buffer,
    });
    res.status(201);
    res.ok(document);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("The research document could not be ingested");
  }
});
router.post("/search/passages", async (req, res) => {
  try {
    res.ok(await searchResearchDocuments(req.body || {}));
  } catch {
    throw new ValidationError("The research document search was rejected");
  }
});
router.delete("/:id", async (req, res) => {
  if (!(await deleteResearchDocument(documentId(req.params.id))))
    throw new NotFoundError("Research document not found");
  res.status(204).end();
});

export default router;
