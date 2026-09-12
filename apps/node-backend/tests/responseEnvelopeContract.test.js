import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(testDir, "../src");

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

describe("response envelope writer convention", () => {
  it("keeps conventionally named response writers at shared envelope and health boundaries", () => {
    const calls = javascriptFiles(sourceRoot).flatMap((file) => {
      const relativePath = path.relative(sourceRoot, file);
      const source = readFileSync(file, "utf8");
      const pattern =
        /\bres\s*\.\s*(?:status\s*\([^)]*\)\s*\.\s*)?(json|send)\s*\(\s*([^)]*)\)/gs;
      return Array.from(source.matchAll(pattern), (match) => ({
        file: relativePath,
        method: match[1],
        argument: match[2].trim(),
      }));
    });

    expect(
      calls
        .filter(({ method, argument }) => method === "json" && argument)
        .map(({ file }) => file),
    ).toEqual([
      "main.js",
      "main.js",
      "main.js",
      "middleware/envelope.js",
      "middleware/errorHandler.js",
    ]);

    expect(
      calls
        .filter(({ method, argument }) => method === "send" && argument)
        .map(({ file, argument }) => ({ file, argument })),
    ).toEqual([{ file: "routes/splits.js", argument: "csv" }]);
  });
});
