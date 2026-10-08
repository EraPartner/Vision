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
  searchResearchDocuments,
} from "../services/aiResearchDocuments.ts";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
const documentIdSchema = z
  .string({ error: "Invalid research document id" })
  .uuid({ error: "Invalid research document id" });

// Multipart text fields; a repeated field arrives as an array and is rejected.
// An empty value falls back to the uploaded file's name.
const uploadFieldsSchema = z.object({
  title: z.string().optional(),
  source_name: z.string().optional(),
});

// The service clamps `limit` to 1..20 (default 8), like parsePagination's maxLimit.
const passageSearchSchema = z.object({
  query: z
    .string({ error: "query must be a non-empty string" })
    .trim()
    .min(1, "query must be a non-empty string"),
  mode: z.enum(["hybrid", "keyword", "semantic"]).optional(),
  limit: z.number().int().positive().optional(),
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
// Input faults are rejected by the schema above; anything the service throws
// after that is a server fault and reaches the error handler as a 500.
router.post("/search/passages", async (req, res) => {
  const search = parseInput(passageSearchSchema, req.body ?? {});
  res.ok(await searchResearchDocuments(search));
});
router.delete("/:id", async (req, res) => {
  if (
    !(await deleteResearchDocument(parseInput(documentIdSchema, req.params.id)))
  )
    throw new NotFoundError("Research document not found");
  res.status(204).end();
});

export default router;
