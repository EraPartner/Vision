export function downsampleLTTB<T>(
  data: T[],
  threshold: number,
  getX?: (item: T, index: number) => number,
  getY?: (item: T) => number,
): T[];
