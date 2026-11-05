#!/usr/bin/env bun
import fs from "node:fs";
import { isEntrypoint } from "./lib/isEntrypoint.ts";
import {
  parseListFile,
  repoPath,
  writeGenerated,
} from "./lib/nativeCodegen.ts";

/**
 * Generates Vision Native's String Catalog (ADR-204 decision 8: one source for
 * EN/NL copy) from i18n/source/{en,nl}.json, for the keys the native code uses,
 * listed in apps/native/i18n-keys.txt.
 *
 *   bun run native:generate-strings
 *
 * Placeholders stay in the `{name}` form of the web app; the native lookup
 * fills them in the same way as `t()`.
 */

export const KEYS = "apps/native/i18n-keys.txt";
export const OUTPUT =
  "apps/native/Sources/VisionNativeUI/Resources/Localizable.xcstrings";
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

/** The catalog JSON: keys sorted, every key translated in every language. */
export function generateCatalog(
  keys: readonly string[],
  tables: Record<string, Table>,
): string {
  const problems: string[] = [];
  const strings: Record<string, unknown> = {};
  for (const key of [...keys].sort()) {
    const localizations: Record<string, unknown> = {};
    for (const language of LANGUAGES) {
      const value = tables[language]?.[key];
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(`${key} has no ${language} text`);
        continue;
      }
      localizations[language] = { stringUnit: { state: "translated", value } };
    }
    strings[key] = {
      comment: "Generated from i18n/source by scripts/native-strings.ts.",
      extractionState: "manual",
      localizations,
    };
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return `${JSON.stringify({ sourceLanguage: "en", strings, version: "1.0" }, null, 2)}\n`;
}

function main(): void {
  try {
    const keys = parseListFile(fs.readFileSync(repoPath(KEYS), "utf8"), KEYS);
    const tables = Object.fromEntries(
      LANGUAGES.map((language) => [language, readTable(language)]),
    );
    writeGenerated(repoPath(OUTPUT), generateCatalog(keys, tables));
  } catch (error) {
    console.error(
      `[native-strings] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (isEntrypoint(import.meta)) main();
