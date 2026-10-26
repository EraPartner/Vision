import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.ts";
import { parseInput } from "../lib/zodInput.ts";
import {
  deleteResearchDocument,
  getResearchDocument,
  ingestResearchDocument,
  listResearchDocuments,
} from "../services/aiResearchDocuments.ts";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
const documentIdSchema = z.uuid({ error: "Invalid research document id" });

// Multipart text fields; a repeated field arrives as an array and is rejected.
// An empty value falls back to the uploaded file's name.
const uploadFieldsSchema = z.object({
  title: z.string().optional(),
  source_name: z.string().optional(),
});

router.get("/", async (_req, res) => {
  const items = await listResearchDocuments();
  res.ok({ items, total: items.length });
});
router.get("/:id", async (req, res) => {
  const document = await getResearchDocument(
    parseInput(documentIdSchema, req.params.id),
  );
  if (!document) throw new NotFoundError("Research document not found");
  res.ok(document);
});
router.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) throw new ValidationError("A file is required");
  const fields = parseInput(uploadFieldsSchema, req.body ?? {});
  try {
    const document = await ingestResearchDocument({
      title: fields.title || req.file.originalname,
      sourceName: fields.source_name || req.file.originalname,
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
router.delete("/:id", async (req, res) => {
  if (
    !(await deleteResearchDocument(parseInput(documentIdSchema, req.params.id)))
  )
    throw new NotFoundError("Research document not found");
  res.status(204).end();
});

export default router;
