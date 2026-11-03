/**
 * Facts about Vision's SQLite database file that the desktop shell can read
 * without the backend or the bundled Bun (ADR-263): the sizes of the database,
 * its write-ahead log and shared-memory index, and the fields of the 100-byte
 * SQLite file header (page size, page count, freelist, the schema version the
 * migration runner records in `PRAGMA user_version`, and the SQLite library
 * that last wrote the file).
 *
 * In WAL mode the header describes the database as of the last checkpoint;
 * pages committed since then live in the `-wal` file, whose size is reported
 * separately. Integrity and the migration ledger are checked by
 * `apps/node-backend/scripts/db-file.ts verify`, not here.
 */
import fs from "node:fs";

/** The 16-byte magic every SQLite 3 database file starts with. */
export const SQLITE_HEADER_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
export const SQLITE_HEADER_BYTES = 100;

export type SqliteTextEncoding = "UTF-8" | "UTF-16le" | "UTF-16be";

export interface SqliteFileHeader {
  pageSize: number;
  /** `wal` when the file was last opened in WAL mode (format versions 2/2). */
  journalMode: "wal" | "rollback";
  /** Pages according to the header, or undefined when the header count is stale. */
  pageCount: number | undefined;
  freelistPages: number;
  schemaFormat: number;
  textEncoding: SqliteTextEncoding | undefined;
  /** `PRAGMA user_version`: the migration runner sets it to the latest applied version. */
  userVersion: number;
  applicationId: number;
  /** SQLITE_VERSION_NUMBER of the library that last wrote the file. */
  sqliteVersionNumber: number;
}

export interface DatabaseFileStats {
  file: string;
  exists: boolean;
  /** Size of the main database file. */
  bytes: number;
  /** Size of `<file>-wal`; 0 when there is none. */
  walBytes: number;
  /** Size of `<file>-shm`; 0 when there is none. */
  shmBytes: number;
  pageSize: number | undefined;
  /** Header page count when it is current, otherwise bytes / pageSize. */
  pageCount: number | undefined;
  freelistPages: number | undefined;
  /** Bytes held by free pages that `VACUUM` would return. */
  freeBytes: number | undefined;
  journalMode: "wal" | "rollback" | undefined;
  textEncoding: SqliteTextEncoding | undefined;
  /** Latest applied migration version (header `user_version`); undefined without a file. */
  schemaVersion: number | undefined;
  /** "3.43.2" for the library that last wrote the file. */
  sqliteVersion: string | undefined;
}

type DatabaseStatsError = Error & { code?: string };

function statsError(message: string, code: string): DatabaseStatsError {
  return Object.assign(new Error(message), { code });
}

export function isSqliteHeader(buffer: Buffer): boolean {
  return (
    buffer.length >= SQLITE_HEADER_MAGIC.length &&
    buffer.subarray(0, SQLITE_HEADER_MAGIC.length).equals(SQLITE_HEADER_MAGIC)
  );
}

/** "3.43.2" from SQLITE_VERSION_NUMBER 3043002; undefined for 0. */
export function sqliteVersionString(versionNumber: number): string | undefined {
  if (!Number.isSafeInteger(versionNumber) || versionNumber <= 0)
    return undefined;
  const major = Math.floor(versionNumber / 1_000_000);
  const minor = Math.floor(versionNumber / 1_000) % 1_000;
  const patch = versionNumber % 1_000;
  return `${major}.${minor}.${patch}`;
}

const TEXT_ENCODINGS: Readonly<Record<number, SqliteTextEncoding>> = {
  1: "UTF-8",
  2: "UTF-16le",
  3: "UTF-16be",
};

/** Parses the first 100 bytes of a SQLite database file. */
export function parseSqliteHeader(buffer: Buffer): SqliteFileHeader {
  if (buffer.length < SQLITE_HEADER_BYTES || !isSqliteHeader(buffer)) {
    throw statsError("The file is not a SQLite database", "NOT_SQLITE_DATABASE");
  }
  const rawPageSize = buffer.readUInt16BE(16);
  const pageSize = rawPageSize === 1 ? 65_536 : rawPageSize;
  if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) {
    throw statsError(
      "The SQLite header has an invalid page size",
      "NOT_SQLITE_DATABASE",
    );
  }
  const writeVersion = buffer.readUInt8(18);
  const readVersion = buffer.readUInt8(19);
  const changeCounter = buffer.readUInt32BE(24);
  const headerPages = buffer.readUInt32BE(28);
  const versionValidFor = buffer.readUInt32BE(92);
  return {
    pageSize,
    journalMode: writeVersion === 2 && readVersion === 2 ? "wal" : "rollback",
    // The in-header size is valid only when it is set and the file was last
    // written by a library that maintains it (SQLite file format, section 1.3.7).
    pageCount:
      headerPages > 0 && changeCounter === versionValidFor
        ? headerPages
        : undefined,
    freelistPages: buffer.readUInt32BE(36),
    schemaFormat: buffer.readUInt32BE(44),
    textEncoding: TEXT_ENCODINGS[buffer.readUInt32BE(56)],
    userVersion: buffer.readInt32BE(60),
    applicationId: buffer.readInt32BE(68),
    sqliteVersionNumber: buffer.readUInt32BE(96),
  };
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

async function sizeOf(file: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() ? stat.size : 0;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
}

/** Reads the leading bytes of a regular file; a shorter file returns fewer bytes. */
export async function readFileHead(file: string, length: number): Promise<Buffer> {
  const handle = await fs.promises.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** True when the path is a regular file that starts with the SQLite magic. */
export async function isSqliteDatabaseFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile()) return false;
    return isSqliteHeader(await readFileHead(file, SQLITE_HEADER_MAGIC.length));
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ELOOP")
      return false;
    throw error;
  }
}

/** File-system statistics of a database file; a missing file reports exists: false. */
export async function readDatabaseFileStats(
  file: string,
): Promise<DatabaseFileStats> {
  let bytes: number;
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile()) {
      throw statsError(
        "The database path is not a regular file",
        "DATABASE_PATH_UNSAFE",
      );
    }
    bytes = stat.size;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return {
      file,
      exists: false,
      bytes: 0,
      walBytes: await sizeOf(`${file}-wal`),
      shmBytes: await sizeOf(`${file}-shm`),
      pageSize: undefined,
      pageCount: undefined,
      freelistPages: undefined,
      freeBytes: undefined,
      journalMode: undefined,
      textEncoding: undefined,
      schemaVersion: undefined,
      sqliteVersion: undefined,
    };
  }
  const walBytes = await sizeOf(`${file}-wal`);
  const shmBytes = await sizeOf(`${file}-shm`);
  if (bytes === 0) {
    // SQLite creates the file empty and writes page 1 with the first table.
    return {
      file,
      exists: true,
      bytes,
      walBytes,
      shmBytes,
      pageSize: undefined,
      pageCount: 0,
      freelistPages: 0,
      freeBytes: 0,
      journalMode: undefined,
      textEncoding: undefined,
      schemaVersion: 0,
      sqliteVersion: undefined,
    };
  }
  const header = parseSqliteHeader(
    await readFileHead(file, SQLITE_HEADER_BYTES),
  );
  return {
    file,
    exists: true,
    bytes,
    walBytes,
    shmBytes,
    pageSize: header.pageSize,
    pageCount: header.pageCount ?? Math.floor(bytes / header.pageSize),
    freelistPages: header.freelistPages,
    freeBytes: header.freelistPages * header.pageSize,
    journalMode: header.journalMode,
    textEncoding: header.textEncoding,
    schemaVersion: header.userVersion,
    sqliteVersion: sqliteVersionString(header.sqliteVersionNumber),
  };
}

/** One log line for diagnostics, without paths or data. */
export function describeDatabaseFileStats(stats: DatabaseFileStats): string {
  if (!stats.exists) return "database file absent";
  return [
    `bytes=${stats.bytes}`,
    `wal=${stats.walBytes}`,
    `pages=${stats.pageCount ?? "?"}x${stats.pageSize ?? "?"}`,
    `free=${stats.freelistPages ?? "?"}`,
    `schema=${stats.schemaVersion ?? "?"}`,
    `journal=${stats.journalMode ?? "?"}`,
    `sqlite=${stats.sqliteVersion ?? "?"}`,
  ].join(" ");
}

/** User-data tables whose row counts a restore or Demo seed must keep exactly. */
export const IMPORTANT_TABLES = Object.freeze([
  "accounts",
  "attachments",
  "investments",
  "planned_transactions",
  "portfolio_transactions",
  "recipients",
  "transactions",
  "user_settings",
] as const);

/**
 * Important tables the backend writes on its own once it runs (daily-job and
 * repair bookkeeping in user_settings), so a comparison after startup skips them.
 */
export const STARTUP_WRITTEN_TABLES: readonly string[] = Object.freeze([
  "user_settings",
]);

/** Important tables a comparison after the backend started can still require to be equal. */
export const STABLE_TABLES: readonly string[] = Object.freeze(
  IMPORTANT_TABLES.filter((table) => !STARTUP_WRITTEN_TABLES.includes(table)),
);

/**
 * Throws DATABASE_COUNT_MISMATCH naming every table whose row count differs.
 * Without `tables`, every table either side reports is compared.
 */
export function assertTableCountsEqual(
  expected: Readonly<Record<string, number>>,
  actual: Readonly<Record<string, number>>,
  { tables }: { tables?: readonly string[] | undefined } = {},
): void {
  const names =
    tables ?? [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
  const mismatches = [...names]
    .sort()
    .filter((table) => expected[table] !== actual[table])
    .map(
      (table) =>
        `${table}: expected ${expected[table] ?? "none"}, found ${actual[table] ?? "none"}`,
    );
  if (mismatches.length > 0) {
    throw statsError(
      `Database row counts do not match (${mismatches.join("; ")})`,
      "DATABASE_COUNT_MISMATCH",
    );
  }
}
