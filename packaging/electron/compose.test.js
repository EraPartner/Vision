'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function loadForTest(request, parent, isMain) {
  if (request === 'electron') return { app: { isPackaged: false } };
  return originalLoad.call(this, request, parent, isMain);
};
const { ensurePostgresImage } = require('./compose');
Module._load = originalLoad;

test('keeps a cached PostgreSQL image that passes the startup check', async () => {
  const calls = [];
  const runner = async (bin, args, cwd, options) => {
    calls.push({ bin, args, cwd, options });
    return 'postgres (PostgreSQL) 18';
  };

  const refreshed = await ensurePostgresImage('/repo', runner);

  assert.equal(refreshed, false);
  assert.deepEqual(calls, [
    {
      bin: 'docker',
      args: [
        'run',
        '--rm',
        '--platform',
        'linux/amd64',
        '--pull=never',
        'postgres:18-alpine',
        'postgres',
        '--version',
      ],
      cwd: '/repo',
      options: { timeout: 30000 },
    },
  ]);
});

test('pulls and retests a PostgreSQL image whose cached entrypoint is broken', async () => {
  const calls = [];
  const runner = async (bin, args, cwd, options) => {
    calls.push({ bin, args, cwd, options });
    if (calls.length === 1) throw new Error('exec format error');
    return '';
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const refreshed = await ensurePostgresImage('/repo', runner);
    assert.equal(refreshed, true);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(calls.map(({ args }) => args), [
    [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--pull=never',
      'postgres:18-alpine',
      'postgres',
      '--version',
    ],
    ['pull', '--platform', 'linux/amd64', 'postgres:18-alpine'],
    [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--pull=never',
      'postgres:18-alpine',
      'postgres',
      '--version',
    ],
  ]);
});

test('reports a replacement image that still cannot start', async () => {
  let callCount = 0;
  const runner = async () => {
    callCount += 1;
    if (callCount !== 2) throw new Error(`startup failure ${callCount}`);
    return '';
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      ensurePostgresImage('/repo', runner),
      /startup failure 3/
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(callCount, 3);
});
