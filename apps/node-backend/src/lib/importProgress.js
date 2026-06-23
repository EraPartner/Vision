/**
 * Shared SSE progress → percent mapping for the import routers (bank-statement
 * and portfolio). Both pipelines emit the same { phase, current, total, ... }
 * events, so the percent banding (staging 0-40, validating 40-55, matching
 * 55-70, committing 70-100) lives here once instead of per-router.
 */

/* eslint-disable vision-local-money/no-raw-money-arithmetic */
export function progressToPercent(ev) {
  const { phase, current = 0, total = 0, imported = 0, duplicates = 0, errors = 0 } = ev;
  const frac = total > 0 ? current / total : 0;
  let percent = 0;
  if (phase === 'staging') percent = Math.round(frac * 40);
  else if (phase === 'validating') percent = 40 + Math.round(frac * 15);
  else if (phase === 'matching') percent = 55 + Math.round(frac * 15);
  else if (phase === 'committing') percent = 70 + Math.round(frac * 30);
  else if (phase === 'complete') percent = 100;
  return { phase, current, total, imported, duplicates, errors, percent };
}
/* eslint-enable vision-local-money/no-raw-money-arithmetic */
