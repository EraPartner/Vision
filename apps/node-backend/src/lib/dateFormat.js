/**
 * Canonical date formatter, layer-neutral (lib/) so routes and repositories can
 * share it. formatDateToYmd renders a Date as 'YYYY-MM-DD' using UTC extraction
 * — correct for the UTC-constructed and pg-read DATE values the info repositories
 * pass it. (For staging dates parsed from CSV adapters use lib/importDates; for
 * pg-read DATEs that must stay in local time see importPipeline/commit.js.)
 */
export function formatDateToYmd(date) {
  return date.toISOString().split('T')[0];
}
