/**
 * Return an interpolated percentile from an ascending numeric sample.
 */
export function quantile(sortedAsc: number[], percentile: number): number {
  if (sortedAsc.length === 0) return 0;
  const index = (percentile / 100) * (sortedAsc.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedAsc[lower];
  const fraction = index - lower;
  return sortedAsc[lower] * (1 - fraction) + sortedAsc[upper] * fraction;
}

