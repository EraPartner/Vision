/**
 * Largest-Triangle-Three-Buckets (LTTB) downsampling algorithm.
 * Reduces large time-series arrays to `threshold` points while preserving visual shape.
 * Always keeps first and last points.
 *
 * @param {Array} data - Source array
 * @param {number} threshold - Max number of output points
 * @param {(item: any, index: number) => number} [getX] - Accessor for x value (index-based by default)
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
    // Standard LTTB: the selection bucket for output point i is
    // [floor(i*b)+1, floor((i+1)*b)+1) and the apex is averaged over the *next*
    // bucket [floor((i+1)*b)+1, floor((i+2)*b)+1). The windows must NOT be
    // shifted forward — doing so makes the first bucket after data[0]
    // unselectable (a spike there is dropped) and collapses the last iteration
    // onto data[len-1], duplicating the final point pushed below.
    const bucketStart = Math.floor(i * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, len - 1);

    const nextBucketStart = Math.floor((i + 1) * bucketSize) + 1;
    const nextBucketEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, len - 1);

    let avgX = 0;
    let avgY = 0;
    // Count actual iterations rather than deriving the count from the bucket
    // bounds: nextBucketStart can run past `len` on the tail bucket while
    // nextBucketEnd is clamped, so a bound-derived count over-counts and the
    // averaged apex point collapses toward (0,0), distorting the last bucket.
    let avgCount = 0;
    for (let j = nextBucketStart; j < nextBucketEnd && j < len; j++) {
      avgX += getX(data[j], j);
      avgY += getY(data[j]);
      avgCount++;
    }
    if (avgCount > 0) {
      avgX /= avgCount;
      avgY /= avgCount;
    } else {
      // Tail bucket with no "next" points — anchor the apex on the final
      // data point so the triangle-area test stays meaningful.
      avgX = getX(data[len - 1], len - 1);
      avgY = getY(data[len - 1]);
    }

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
