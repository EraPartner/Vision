#!/usr/bin/env bun
import fs from "node:fs";
import { isEntrypoint } from "./lib/isEntrypoint.ts";
import {
  parseListFile,
  repoPath,
  writeGenerated,
} from "./lib/nativeCodegen.ts";

/**
 * Generates Vision Native's string tables (ADR-204 decision 8: one source for
 * EN/NL copy) from i18n/source/{en,nl}.json, for the keys the native code uses,
 * listed in apps/native/i18n-keys.txt: one flat `{ key: text }` JSON file per
 * language, so the app parses only its own language (a String Catalog holding
 * both was about 2.3 MB of JSON to decode at launch).
 *
 *   bun run native:generate-strings
 *
 * Placeholders stay in the `{name}` form of the web app; the native lookup
 * fills them in the same way as `t()`.
 */

export const KEYS = "apps/native/i18n-keys.txt";
export const OUTPUT_DIR = "apps/native/Sources/VisionNativeUI/Resources/Strings";
export const LANGUAGES = ["en", "nl"] as const;

type Table = Record<string, unknown>;

function readTable(language: string): Table {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(repoPath("i18n", "source", `${language}.json`), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`i18n/source/${language}.json is not an object.`);
  }
  return parsed as Table;
}

/** One JSON object per language: keys sorted, every key translated in every language. */
export function generateStringTables(
  keys: readonly string[],
  tables: Record<string, Table>,
): Record<(typeof LANGUAGES)[number], string> {
  const problems: string[] = [];
  const out = Object.fromEntries(LANGUAGES.map((language) => [language, {}])) as Record<
    (typeof LANGUAGES)[number],
    Record<string, string>
  >;
  for (const key of [...keys].sort()) {
    for (const language of LANGUAGES) {
      const value = tables[language]?.[key];
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(`${key} has no ${language} text`);
        continue;
      }
      out[language][key] = value;
    }
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return Object.fromEntries(
    LANGUAGES.map((language) => [language, `${JSON.stringify(out[language], null, 1)}\n`]),
  ) as Record<(typeof LANGUAGES)[number], string>;
}

function main(): void {
  try {
    const keys = parseListFile(fs.readFileSync(repoPath(KEYS), "utf8"), KEYS);
    const tables = Object.fromEntries(
      LANGUAGES.map((language) => [language, readTable(language)]),
    );
    const generated = generateStringTables(keys, tables);
    for (const language of LANGUAGES) {
      writeGenerated(repoPath(OUTPUT_DIR, `${language}.json`), generated[language]);
    }
  } catch (error) {
    console.error(
      `[native-strings] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (isEntrypoint(import.meta)) main();
