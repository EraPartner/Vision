import { Router } from "express";
import multer from "multer";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { cleanup } from "../lib/csvUpload.ts";
import { ValidationError } from "../middleware/errorHandler.ts";
import {
  computeResearchPresentation,
  RESEARCH_PRESENTATION_MAX_BYTES,
} from "../services/research/presentationService.ts";

const router = Router();
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: RESEARCH_PRESENTATION_MAX_BYTES, files: 1, fields: 0 },
});
router.post("/presentation", upload.single("file"), async (req, res) => {
  if (!req.file) throw new ValidationError("No presentation snapshot uploaded");
  try {
    let input: unknown;
    try {
      input = JSON.parse(await readFile(req.file.path, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new ValidationError("Invalid presentation JSON");
      throw error;
    }
    res.ok(computeResearchPresentation(input));
  } finally {
    cleanup(req.file.path);
  }
});
router.use(
  (
    error: unknown,
    _req: unknown,
    _res: unknown,
    next: (error: unknown) => void,
  ) => {
    if (error instanceof multer.MulterError)
      next(new ValidationError(error.message));
    else next(error);
  },
);
export default router;
