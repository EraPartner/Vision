// Keeps psql meta-commands (`\!`, `\copy ... program`, `\i`, `\c`, ...) in a
// restored plain SQL dump from running. A backup file is user-chosen input:
// psql executes backslash commands from `--file` anywhere on a line, so a
// crafted `db.sql` could otherwise run shell commands as the user.
//
// psql 18 (and the 16.10+/17.6+ back branches) has a restricted mode: after
// `\restrict <key>` the only accepted backslash command is `\unrestrict <key>`.
// pg_dump wraps every plain dump in such a pair with a random key.
//
// - A dump whose own pair encloses the whole file, with no other
//   `\unrestrict` anywhere, already restricts itself: it runs unchanged.
// - Anything else (an older dump without the pair, or a file that does not
//   match that shape) runs after a `\restrict` with a fresh random key that
//   the file cannot know, so any backslash command in it fails the restore
//   under ON_ERROR_STOP.

import crypto from "node:crypto";
import fs from "node:fs";

const RESTRICT_LINE = /^\\restrict ([A-Za-z0-9]+)\r?$/;
const UNRESTRICT_LINE = /^\\unrestrict ([A-Za-z0-9]+)\r?$/;
// Bytes are read as latin1, so every 0x5C byte is seen whatever the client
// encoding; the count is deliberately broader than psql's own parser.
const ANY_UNRESTRICT = /\\unrestrict/gi;

/** Lines split on LF only, as psql reads them (a lone CR stays in the line). */
async function* lfLines(filePath: string): AsyncGenerator<string> {
  const input = fs.createReadStream(filePath, { encoding: "latin1" });
  try {
    let rest = "";
    for await (const chunk of input) {
      const parts = (rest + String(chunk)).split("\n");
      rest = parts.pop() ?? "";
      yield* parts;
    }
    if (rest !== "") yield rest;
  } finally {
    input.destroy();
  }
}

/** Whether the dump restricts itself for its whole length (see above). */
async function dumpIsSelfRestricted(sqlPath: string): Promise<boolean> {
  let headerKey: string | undefined;
  let headerDone = false;
  let lastLine = "";
  let unrestrictCount = 0;
  for await (const line of lfLines(sqlPath)) {
    unrestrictCount += line.match(ANY_UNRESTRICT)?.length ?? 0;
    const blank = line.trim() === "";
    if (!headerDone && !blank && !line.startsWith("--")) {
      headerDone = true;
      headerKey = RESTRICT_LINE.exec(line)?.[1];
      if (headerKey === undefined) return false;
    }
    if (!blank) lastLine = line;
  }
  return (
    headerKey !== undefined &&
    unrestrictCount === 1 &&
    UNRESTRICT_LINE.exec(lastLine)?.[1] === headerKey
  );
}

/**
 * psql arguments to place before `--file <sqlPath>`: none for a
 * self-restricted dump, otherwise a `\restrict` with a random key.
 */
export async function psqlRestoreGuardArgs(
  sqlPath: string,
  randomKey: () => string = () => crypto.randomBytes(24).toString("hex"),
): Promise<string[]> {
  if (await dumpIsSelfRestricted(sqlPath)) return [];
  return ["--command", `\\restrict ${randomKey()}`];
}
