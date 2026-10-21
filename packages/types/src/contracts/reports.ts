import { z } from "zod";

/**
 * `POST /api/reports/{financial,portfolio,tax}` (ADR-234): a print-ready
 * report. The desktop shell prints `html` to PDF with `footerTemplate` as the
 * page footer; a plain browser opens its print dialog on `html`.
 */
export const ReportDocumentSchema = z.looseObject({
  filename: z.string().regex(/^vision-(financial|portfolio|tax)-\d{4}-\d{2}-\d{2}\.pdf$/),
  html: z.string().min(1),
  footerTemplate: z.string(),
});

export type ReportDocument = z.infer<typeof ReportDocumentSchema>;
