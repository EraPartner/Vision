/**
 * Errors of the 2.0.0 -> SQLite transition (ADR-263).
 *
 * Every failure the transition can explain is a TransitionError: it names
 * what went wrong, where (table, column, primary key, offending value) and
 * what to do next. The CLI maps `exitCode` to the process exit status:
 * 1 for input and verification errors, 2 for usage errors.
 */

export type ExitCode = 0 | 1 | 2;

export interface ErrorLocation {
  table?: string;
  column?: string;
  /** Primary key of the offending row, as `col=value` pairs. */
  rowKey?: string;
  /** Line of db.sql the value came from (1-based). */
  line?: number;
  /** The offending value, truncated for display. */
  value?: string;
}

export class TransitionError extends Error {
  readonly exitCode: ExitCode;
  readonly location: ErrorLocation;
  /** What the user should do next. */
  readonly hint: string | undefined;

  constructor(
    message: string,
    options: { exitCode?: ExitCode; location?: ErrorLocation; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TransitionError";
    this.exitCode = options.exitCode ?? 1;
    this.location = options.location ?? {};
    this.hint = options.hint;
  }
}

export class UsageError extends TransitionError {
  constructor(message: string) {
    super(message, { exitCode: 2, hint: "Run with --help for the options." });
    this.name = "UsageError";
  }
}

const MAX_VALUE_DISPLAY = 120;

/** A value shortened for messages: JSON-quoted so control characters show. */
export function displayValue(value: string | null): string {
  if (value === null) return "NULL";
  const quoted = JSON.stringify(value);
  if (quoted.length <= MAX_VALUE_DISPLAY) return quoted;
  return `${quoted.slice(0, MAX_VALUE_DISPLAY)}… (${value.length} characters)`;
}

/** The message plus its location and hint, as the CLI prints it. */
export function describeError(err: unknown): string {
  if (!(err instanceof TransitionError)) {
    return err instanceof Error ? (err.stack ?? err.message) : String(err);
  }
  const where: string[] = [];
  const loc = err.location;
  if (loc.table !== undefined) where.push(`table ${loc.table}`);
  if (loc.column !== undefined) where.push(`column ${loc.column}`);
  if (loc.rowKey !== undefined) where.push(`row ${loc.rowKey}`);
  if (loc.line !== undefined) where.push(`db.sql line ${loc.line}`);
  const lines = [err.message];
  if (where.length > 0) lines.push(`  where: ${where.join(", ")}`);
  if (loc.value !== undefined) lines.push(`  value: ${loc.value}`);
  if (err.hint !== undefined) lines.push(`  what to do: ${err.hint}`);
  return lines.join("\n");
}
