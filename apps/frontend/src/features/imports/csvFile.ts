/**
 * Shared "is this a CSV?" guard for the client-side import dropzones. Matches
 * the backend's lenient check (lib/csvUpload.js): accept a text/csv MIME or a
 * .csv extension (case-insensitive), since browsers report inconsistent MIME
 * types for CSVs depending on OS and installed spreadsheet apps.
 */
export function isCsvFile(file: File): boolean {
  return file.type === "text/csv" || file.name.toLowerCase().endsWith(".csv");
}
