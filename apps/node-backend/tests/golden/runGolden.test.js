import { describe, it, expect, beforeAll } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGolden } from './runGolden.js';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

async function writeFixture(relPath, body) {
  const full = join(FIXTURE_ROOT, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(body, null, 2), 'utf8');
}

describe('runGolden harness', () => {
  beforeAll(async () => {
    await rm(join(FIXTURE_ROOT, '__harness_self_test'), { recursive: true, force: true });
  });

  it('passes when actual matches expected', async () => {
    await writeFixture('__harness_self_test/ok.input.json', { n: 2 });
    await writeFixture('__harness_self_test/ok.expected.json', { doubled: 4 });
    await runGolden('__harness_self_test/ok', ({ n }) => ({ doubled: n * 2 }));
  });

  it('fails when actual diverges from expected', async () => {
    await writeFixture('__harness_self_test/drift.input.json', { n: 2 });
    await writeFixture('__harness_self_test/drift.expected.json', { doubled: 4 });
    await expect(
      runGolden('__harness_self_test/drift', ({ n }) => ({ doubled: n * 3 })),
    ).rejects.toThrow();
  });

  it('throws clearly when expected fixture is missing', async () => {
    await writeFixture('__harness_self_test/missing.input.json', { n: 1 });
    await expect(
      runGolden('__harness_self_test/missing', (i) => i),
    ).rejects.toThrow(/UPDATE_GOLDENS=1/);
  });
});
