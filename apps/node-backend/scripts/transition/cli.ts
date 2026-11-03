/**
 * Command line of the Vision 2.0.0 -> SQLite transition. Started by
 * scripts/vision-v2-to-sqlite.ts (`bun run transition:v2 -- <backup>`),
 * which prepares the environment before this module loads the backend.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MIGRATIONS_DIR } from "../../src/database/migrate.ts";
import { UsageError, describeError } from "./errors.ts";
import type { ExitCode } from "./errors.ts";
import { defaultUserData } from "./install.ts";
import { passphraseProvider } from "./passphrase.ts";
import type { RunMode } from "./report.ts";
import { runTransition } from "./run.ts";
import type { RunResult } from "./run.ts";
import { isRecord } from "./util.ts";

export const USAGE = `Usage: bun run transition:v2 -- <backup.visionbak | backup.visionbak.enc> [options]

Converts a Vision 2.0.0 backup (PostgreSQL dump) into Vision's SQLite
database, checks every value, and installs it as
<user data>/database/vision.sqlite3, copying the attachments next to it.
Nothing is installed unless every check passes. The backup file is only
read; PostgreSQL is never contacted.

Options:
  --dry-run                 convert and verify only; install nothing
  --to-backup <file>        write a SQLite backup bundle (format 2) instead of
                            installing; restore it in Vision (Settings > Backups).
                            Encrypted with the same passphrase if the input was.
  --output <file>           write the verified database to <file> instead of
                            installing (for testing; attachments are not copied)
  --user-data <dir>         Vision's data folder
                            (default: ~/Library/Application Support/Vision)
  --passphrase-file <file>  passphrase of an encrypted backup (else
                            VISION_BACKUP_PASSPHRASE, else you are asked)
  --report <file>           where to write the JSON report (default: next to
                            the installed database or output; a failed run's
                            report goes to the temporary directory)
  --verbose                 show the backend's log output
  -h, --help                show this help

Running it again with the same backup after a successful install prints
"already transitioned from this backup" and changes nothing.

Exit status: 0 success (or already transitioned), 1 input or verification
error, 2 usage error.`;

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  onWorkDir?: (dir: string | null) => void;
}

export interface ParsedArgs {
  input: string;
  mode: RunMode;
  userData: string;
  toBackup: string | undefined;
  output: string | undefined;
  report: string | undefined;
  passphraseFile: string | undefined;
  verbose: boolean;
}

export function parseCli(argv: readonly string[]): ParsedArgs | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        "dry-run": { type: "boolean" },
        "to-backup": { type: "string" },
        output: { type: "string" },
        "user-data": { type: "string" },
        "passphrase-file": { type: "string" },
        report: { type: "string" },
        verbose: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const v = parsed.values;
  if (v.help === true) return "help";
  if (parsed.positionals.length !== 1) {
    throw new UsageError(
      parsed.positionals.length === 0 ? "Pass the backup file to convert." : `Pass one backup file, not ${parsed.positionals.length}.`,
    );
  }
  const modes = [v["dry-run"] === true, v["to-backup"] !== undefined, v.output !== undefined].filter(Boolean).length;
  if (modes > 1) throw new UsageError("--dry-run, --to-backup and --output exclude each other.");
  for (const [name, value] of [
    ["--to-backup", v["to-backup"]],
    ["--output", v.output],
    ["--user-data", v["user-data"]],
    ["--passphrase-file", v["passphrase-file"]],
    ["--report", v.report],
  ] as const) {
    if (value === "") throw new UsageError(`${name} needs a path.`);
  }
  const mode: RunMode =
    v["dry-run"] === true ? "dry-run" : v["to-backup"] !== undefined ? "to-backup" : v.output !== undefined ? "output" : "install";
  if (mode !== "install" && v["user-data"] !== undefined && mode !== "dry-run") {
    throw new UsageError("--user-data only applies to an install (or a dry run).");
  }
  return {
    input: parsed.positionals[0] ?? "",
    mode,
    userData: path.resolve(v["user-data"] ?? defaultUserData()),
    toBackup: v["to-backup"],
    output: v.output,
    report: v.report,
    passphraseFile: v["passphrase-file"],
    verbose: v.verbose === true,
  };
}

/** The version of this checkout (root package.json). */
export function toolVersion(): string {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "package.json");
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isRecord(parsed) && typeof parsed.version === "string") return parsed.version;
  } catch {
    // fall through
  }
  return "unknown";
}

export async function main(argv: readonly string[], io: CliIo): Promise<{ exitCode: ExitCode; result: RunResult | null }> {
  let args: ParsedArgs | "help";
  try {
    args = parseCli(argv);
  } catch (err) {
    io.stderr(describeError(err));
    return { exitCode: 2, result: null };
  }
  if (args === "help") {
    io.stdout(USAGE);
    return { exitCode: 0, result: null };
  }
  if (args.passphraseFile !== undefined && !fs.existsSync(args.passphraseFile)) {
    io.stderr(describeError(new UsageError(`--passphrase-file ${args.passphraseFile} does not exist.`)));
    return { exitCode: 2, result: null };
  }
  io.stderr(`Migrations: ${MIGRATIONS_DIR}`);
  const result = await runTransition({
    input: args.input,
    mode: args.mode,
    userData: args.userData,
    toBackup: args.toBackup,
    output: args.output,
    report: args.report,
    passphrase: passphraseProvider({ file: args.passphraseFile, env: io.env, interactive: io.interactive }),
    print: io.stdout,
    progress: io.stderr,
    toolVersion: toolVersion(),
    onWorkDir: io.onWorkDir,
  });
  return { exitCode: result.exitCode, result };
}
