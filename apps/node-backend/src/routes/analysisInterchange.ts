import { Router } from "express";
import multer from "multer";
import os from "node:os";
import { z } from "zod";
import { cleanup, uploadTempPath } from "../lib/csvUpload.ts";
import { parseInput } from "../lib/zodInput.ts";
import { ValidationError } from "../middleware/errorHandler.ts";
import {
  ANALYSIS_EXPORT_MAX_BYTES,
  importAnalysisInterchange,
  exportAnalysisInterchange,
} from "../services/analysisInterchangeService.ts";

const router = Router();
const input = z.object({ format: z.enum(["csv", "xlsx"]) });
const importUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 10_000_000, files: 1, fields: 1, fieldSize: 16 },
});
const exportUpload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: ANALYSIS_EXPORT_MAX_BYTES,
    files: 1,
    fields: 1,
    fieldSize: 16,
  },
});
router.post(
  "/interchange/import",
  importUpload.single("file"),
  async (req, res) => {
    if (!req.file) throw new ValidationError("No file uploaded");
    try {
      const { format } = parseInput(input, req.body);
      res.ok(
        await importAnalysisInterchange(
          uploadTempPath(req.file.path),
          req.file.originalname,
          format,
        ),
      );
    } finally {
      cleanup(req.file.path);
    }
  },
);
router.post(
  "/interchange/export",
  exportUpload.single("file"),
  async (req, res) => {
    if (!req.file) throw new ValidationError("No export snapshot uploaded");
    try {
      const { format } = parseInput(input, req.body);
      const bytes = await exportAnalysisInterchange(
        uploadTempPath(req.file.path),
        format,
      );
      res.attachment(`analysis.${format}`);
      res.type(
        format === "csv"
          ? "text/csv; charset=utf-8"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.send(Buffer.from(bytes));
    } finally {
      cleanup(req.file.path);
    }
  },
);
router.use(
  (
    error: unknown,
    _req: unknown,
    _res: unknown,
    next: (error?: unknown) => void,
  ) => {
    if (error instanceof multer.MulterError)
      next(
        new ValidationError(`Analysis interchange upload: ${error.message}`),
      );
    else next(error);
  },
);
export default router;
