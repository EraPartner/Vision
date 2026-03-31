/**
 * Largest-Triangle-Three-Buckets (LTTB) downsampling algorithm.
 * Reduces large time-series arrays to `threshold` points while preserving visual shape.
 * Always keeps first and last points.
 *
 * @param data - Source array
 * @param threshold - Max number of output points (returns original if data.length <= threshold)
 * @param getX - Accessor for x value (index-based by default)
 * @param getY - Accessor for y value
 */
export function downsampleLTTB<T>(
  data: T[],
  threshold: number,
  getX: (item: T, index: number) => number = (_item, i) => i,
  getY: (item: T) => number,
): T[] {
  const len = data.length;
  if (len <= threshold || threshold < 3) return data;

  const sampled: T[] = [data[0]]; // Always keep first
  const bucketSize = (len - 2) / (threshold - 2);

  let prevSelectedIndex = 0;

  for (let i = 0; i < threshold - 2; i++) {
    const bucketStart = Math.floor((i + 1) * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, len - 1);

    // Average of next bucket for area calculation
    const nextBucketStart = Math.floor((i + 2) * bucketSize) + 1;
    const nextBucketEnd = Math.min(Math.floor((i + 3) * bucketSize) + 1, len - 1);

    let avgX = 0;
    let avgY = 0;
    const avgCount = Math.max(1, nextBucketEnd - nextBucketStart);
    for (let j = nextBucketStart; j < nextBucketEnd && j < len; j++) {
      avgX += getX(data[j], j);
      avgY += getY(data[j]);
    }
    avgX /= avgCount;
    avgY /= avgCount;

    const prevX = getX(data[prevSelectedIndex], prevSelectedIndex);
    const prevY = getY(data[prevSelectedIndex]);

    let maxArea = -1;
    let maxAreaIndex = bucketStart;

    for (let j = bucketStart; j < bucketEnd && j < len; j++) {
      const area = Math.abs(
        (getX(data[j], j) - prevX) * (avgY - prevY) -
        (avgX - prevX) * (getY(data[j]) - prevY)
      );
      if (area > maxArea) {
        maxArea = area;
        maxAreaIndex = j;
      }
    }

    sampled.push(data[maxAreaIndex]);
    prevSelectedIndex = maxAreaIndex;
  }

  sampled.push(data[len - 1]); // Always keep last
  return sampled;
}
