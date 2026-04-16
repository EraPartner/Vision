/**
 * Largest-Triangle-Three-Buckets (LTTB) downsampling algorithm.
 * Reduces large time-series arrays to `threshold` points while preserving visual shape.
 * Always keeps first and last points.
 *
 * Ported from apps/frontend/src/utils/downsample.ts
 *
 * @param {Array} data - Source array
 * @param {number} threshold - Max number of output points
 * @param {(item: any, index: number) => number} getX - Accessor for x value
 * @param {(item: any) => number} getY - Accessor for y value
 * @returns {Array} Downsampled array
 */
export function downsampleLTTB(data, threshold, getX = (_item, i) => i, getY) {
  const len = data.length;
  if (len <= threshold || threshold < 3) return data;

  const sampled = [data[0]];
  const bucketSize = (len - 2) / (threshold - 2);

  let prevSelectedIndex = 0;

  for (let i = 0; i < threshold - 2; i++) {
    const bucketStart = Math.floor((i + 1) * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, len - 1);

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

  sampled.push(data[len - 1]);
  return sampled;
}
