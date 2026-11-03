/**
 * Attachments: the files of the bundle's attachments/ tree, checked against
 * the `attachments` table, and copied into Vision's attachments directory
 * without overwriting anything, each copy verified by SHA-256.
 *
 * The directory is the one Vision 2.0 used and the SQLite runtime keeps:
 * `<userData>/native/vision/attachments`, with each row's stored_path
 * (`{transaction_id}/{uuid}.{ext}`) relative to it.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BundleAttachment } from "./bundle.ts";
import { TransitionError } from "./errors.ts";
import { copyNewFile, isInside, makePrivateDirectory, pathExists, sha256File, syncDirectory } from "./files.ts";
import { isRecord } from "./util.ts";

export interface AttachmentCrossCheck {
  rows: number;
  files: number;
  bytes: number;
  missingFiles: string[];
  filesWithoutRow: string[];
  sizeMismatches: string[];
  warnings: string[];
}

/** Compare the attachments rows with the bundle's files. Differences are warnings: 2.0 had them too. */
export function crossCheckAttachments(db: DatabaseSync, files: readonly BundleAttachment[]): AttachmentCrossCheck {
  const statement = db.prepare("SELECT id, stored_path, size_bytes FROM attachments ORDER BY id");
  statement.setReadBigInts(true);
  const rows = statement.all() as Array<{ id: bigint; stored_path: string; size_bytes: bigint }>;
  const byPath = new Map(files.map((f) => [f.relativePath, f]));
  const referenced = new Set<string>();
  const missingFiles: string[] = [];
  const sizeMismatches: string[] = [];
  for (const row of rows) {
    referenced.add(row.stored_path);
    const file = byPath.get(row.stored_path);
    if (file === undefined) missingFiles.push(`attachment ${row.id.toString()}: ${row.stored_path}`);
    else if (BigInt(file.bytes) !== row.size_bytes) {
      sizeMismatches.push(`attachment ${row.id.toString()}: ${row.stored_path} is ${file.bytes} bytes, the row says ${row.size_bytes.toString()}`);
    }
  }
  const filesWithoutRow = files.filter((f) => !referenced.has(f.relativePath)).map((f) => f.relativePath);
  const warnings: string[] = [];
  if (missingFiles.length > 0) {
    warnings.push(
      `${missingFiles.length} attachment row(s) have no file in the backup (they had none in Vision 2.0 either): ` +
        missingFiles.slice(0, 10).join("; "),
    );
  }
  if (filesWithoutRow.length > 0) {
    warnings.push(
      `${filesWithoutRow.length} file(s) in the backup's attachments/ belong to no attachment row; copied anyway: ` +
        filesWithoutRow.slice(0, 10).join("; "),
    );
  }
  if (sizeMismatches.length > 0) warnings.push(`attachment sizes differ from their rows: ${sizeMismatches.slice(0, 10).join("; ")}`);
  return {
    rows: rows.length,
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    missingFiles,
    filesWithoutRow,
    sizeMismatches,
    warnings,
  };
}

/** Re-hash the extracted files: they must still be what the archive held. */
export async function rehashExtracted(files: readonly BundleAttachment[]): Promise<string[]> {
  const problems: string[] = [];
  for (const file of files) {
    const sha = await sha256File(file.extractedPath);
    if (sha !== file.sha256) problems.push(`${file.relativePath}: extracted copy has SHA-256 ${sha}, archive ${file.sha256}`);
  }
  return problems;
}

/** Saved custom-SQL analyses: their SQL was written for PostgreSQL and is not checked here. */
export function customSqlAnalyses(db: DatabaseSync): Array<{ savedAnalysisId: string; version: number }> {
  const found: Array<{ savedAnalysisId: string; version: number }> = [];
  const rows = db
    .prepare("SELECT saved_analysis_id AS id, version, definition_json AS d FROM saved_analysis_definition_versions ORDER BY 1, 2")
    .all() as Array<{ id: string; version: number | bigint; d: string }>;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.d);
    } catch {
      continue;
    }
    const source = isRecord(parsed) ? parsed.source : undefined;
    if (isRecord(source) && source.kind === "custom-sql") found.push({ savedAnalysisId: row.id, version: Number(row.version) });
  }
  return found;
}

export interface AttachmentPlanEntry {
  file: BundleAttachment;
  destination: string;
  /** Already there with the same SHA-256 (an earlier, interrupted run, or Vision 2.0's own copy). */
  present: boolean;
}

/** Decide every copy before writing anything; refuse any file that would be replaced. */
export async function planAttachmentCopies(
  files: readonly BundleAttachment[],
  attachmentsDir: string,
): Promise<AttachmentPlanEntry[]> {
  const plan: AttachmentPlanEntry[] = [];
  for (const file of files) {
    const destination = path.join(attachmentsDir, ...file.relativePath.split("/"));
    if (!isInside(attachmentsDir, destination)) {
      throw new TransitionError(`Attachment path ${file.relativePath} leaves the attachments directory.`);
    }
    let present = false;
    if (await pathExists(destination)) {
      const stat = await fs.promises.lstat(destination);
      const sha = stat.isFile() ? await sha256File(destination) : "";
      if (sha !== file.sha256) {
        throw new TransitionError(
          `${destination} already exists and differs from the backup's copy; the transition never overwrites a file.`,
          {
            hint:
              "Another Vision installation's attachments are in this folder. Move them aside (keep them), or run " +
              "with --user-data pointing to the Vision data folder you mean.",
          },
        );
      }
      present = true;
    }
    plan.push({ file, destination, present });
  }
  return plan;
}

/** Copy each planned attachment: temp file, fsync, link to its name, unlink the temp, verify. */
export async function copyAttachments(plan: readonly AttachmentPlanEntry[], attachmentsDir: string): Promise<number> {
  await makePrivateDirectory(attachmentsDir);
  let copied = 0;
  const touchedDirs = new Set<string>();
  for (const entry of plan) {
    if (entry.present) continue;
    const dir = path.dirname(entry.destination);
    await makePrivateDirectory(dir);
    const temp = path.join(dir, `.transition-${randomBytes(6).toString("hex")}.tmp`);
    const sha = await copyNewFile(entry.file.extractedPath, temp);
    try {
      if (sha !== entry.file.sha256) {
        throw new TransitionError(`Copying ${entry.file.relativePath} produced a different file (SHA-256 ${sha}).`, {
          hint: "The disk may be failing or full. Nothing was overwritten; check the disk and run again.",
        });
      }
      try {
        await fs.promises.link(temp, entry.destination);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new TransitionError(`${entry.destination} appeared while the transition ran; it was not overwritten.`, {
            hint: "Quit Vision and run the transition again.",
          });
        }
        throw err;
      }
    } finally {
      await fs.promises.rm(temp, { force: true });
    }
    touchedDirs.add(dir);
    copied++;
  }
  for (const dir of touchedDirs) await syncDirectory(dir);
  return copied;
}

/** After the copy: every bundle file is in place with its SHA-256. */
export async function verifyInstalledAttachments(plan: readonly AttachmentPlanEntry[]): Promise<string[]> {
  const problems: string[] = [];
  for (const entry of plan) {
    const sha = (await pathExists(entry.destination)) ? await sha256File(entry.destination) : "missing";
    if (sha !== entry.file.sha256) problems.push(`${entry.destination}: SHA-256 ${sha}, backup ${entry.file.sha256}`);
  }
  return problems;
}
