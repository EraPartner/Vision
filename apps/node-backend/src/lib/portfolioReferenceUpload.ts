/** Bounded upload boundary for a Portfolio Performance XML reference. */

import os from "node:os";
import multer from "multer";
import { ValidationError } from "../middleware/errorHandler.ts";

const FILE_TYPE_ERROR =
  "Reference file must be a Portfolio Performance XML export";

export const portfolioReferenceUpload = multer({
  dest: os.tmpdir(),
  // Busboy emits partsLimit when the threshold is reached. Three valid parts
  // therefore need a threshold of four; file/field limits still reject extras.
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2, parts: 4 },
  fileFilter: (
    _req: unknown,
    file: { originalname?: string; mimetype?: string },
    callback: (error: Error | null, acceptFile?: boolean) => void,
  ) => {
    const name = file.originalname?.toLowerCase() || "";
    const mime = file.mimetype?.toLowerCase() || "";
    if (
      !name.endsWith(".xml") ||
      ![
        "",
        "application/xml",
        "text/xml",
        "text/plain",
        "application/octet-stream",
      ].includes(mime)
    )
      callback(new ValidationError(FILE_TYPE_ERROR));
    else callback(null, true);
  },
});

export function portfolioReferenceUploadErrorTranslator(
  // multer resolves to an untyped ambient module, so `instanceof
  // multer.MulterError` cannot narrow an `unknown` here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: any,
  req: unknown,
  res: unknown,
  next: (error?: unknown) => void,
) {
  if (error instanceof multer.MulterError) {
    return next(
      new ValidationError(
        error.code === "LIMIT_FILE_SIZE"
          ? "Reference file size exceeds maximum of 10MB"
          : `Reference upload error: ${error.message}`,
      ),
    );
  }
  next(error);
}
