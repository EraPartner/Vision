/** Read-only multipart probe kept separate from batch mutation route dependencies. */
import type { Router } from "express";
import { z } from "zod";
import { bareMessages, parseInput } from "../lib/zodInput.ts";
import { csvEncodingField } from "../lib/parserConfigSchema.ts";
import { portfolioUpload } from "../lib/portfolioUpload.ts";
import { cleanup } from "../lib/csvUpload.ts";
import { ValidationError } from "../middleware/errorHandler.ts";
import { probePortfolioImport } from "../services/portfolioImportProbe.ts";

const probeInput = bareMessages(
  z.object({
    separator: z.enum([",", ";", "\t", "|"]).optional(),
    encoding: csvEncodingField,
    skipRows: z
      .string()
      .regex(/^\d{1,6}$/)
      .transform(Number)
      .default(0),
  }),
);

export function registerPortfolioImportProbeRoute(router: Router) {
  router.post("/probe", portfolioUpload.single("file"), async (req, res) => {
    if (!req.file) throw new ValidationError("No file uploaded.");
    try {
      const options = parseInput(probeInput, req.body);
      res.ok(
        await probePortfolioImport(
          req.file.path,
          req.file.originalname,
          options,
        ),
      );
    } finally {
      cleanup(req.file.path);
    }
  });
}
