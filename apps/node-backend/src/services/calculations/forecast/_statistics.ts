/**
 * Return an interpolated percentile from an ascending numeric sample.
 */
export function quantile(sortedAsc: number[], percentile: number): number {
  if (sortedAsc.length === 0) return 0;
  const index = (percentile / 100) * (sortedAsc.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sortedAsc[lower];
  const upperValue = sortedAsc[upper];
  // A percentile outside 0..100 indexes past the sample. That has always
  // returned the missing element itself (undefined) on an integer index and
  // NaN otherwise; both are kept unchanged here.
  if (lower === upper) return lowerValue as number;
  if (lowerValue === undefined || upperValue === undefined) return NaN;
  const fraction = index - lower;
  return lowerValue * (1 - fraction) + upperValue * fraction;
}

