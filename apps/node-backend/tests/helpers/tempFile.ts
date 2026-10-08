/**
 * Temp-CSV helper for bank-adapter tests.
 *
 * Each adapter test wrote a CSV fixture to the OS temp dir, parsed it, and
 * removed it in an `afterEach`. `useTempCSV(prefix)` centralizes that: it
 * returns a `writeTempCSV(content)` that writes a uniquely-named temp CSV and
 * registers an `afterEach` that deletes every file it created.
 *
 * Usage:
 *   import { useTempCSV } from '../helpers/tempFile.ts';
 *   const writeTempCSV = useTempCSV('revolut');
 *   const tmpPath = writeTempCSV(SAMPLE_CSV);
 */
import { afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * @param prefix Filename prefix (e.g. the bank name).
 * @returns writer returning the temp file path.
 */
export function useTempCSV(prefix: string): (content: string) => string {
  const files: string[] = [];
  afterEach(() => {
    while (files.length) {
      const p = files.pop() as string;
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore cleanup errors */
      }
    }
  });
  return (content: string) => {
    const tmpPath = path.join(os.tmpdir(), `test_${prefix}_${Date.now()}_${files.length}.csv`);
    fs.writeFileSync(tmpPath, content, 'utf-8');
    files.push(tmpPath);
    return tmpPath;
  };
}
