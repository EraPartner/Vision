#!/usr/bin/env node
/**
 * Guards packaging/electron/resources/docker-compose.yml against drifting from
 * the root docker-compose.yml on the two properties that decide which volumes a
 * user's data lives in:
 *
 *   1. the top-level `name:` (the compose project name) — every named volume is
 *      created as `<project>_<volume>`, so a project-name change silently points
 *      the packaged app at a different, empty database
 *   2. the top-level `volumes:` key set — omitting the attachments volume here
 *      is exactly the v1.0.2 data-loss bug
 *
 * This replaces two byte-identical copies of an inline awk one-liner (ci.yml's
 * verify-compose-sync job and release.yml's verify job) that could drift from
 * each other and had no local equivalent. Both workflows and .githooks/pre-push
 * now call this file instead.
 *
 * Why the hand-rolled parser: the two callers that matter most run with nothing
 * but a checkout — CI's verify-compose-sync job installs no toolchain, and the
 * git hook must work before `bun install` — so this stays stdlib-only, like
 * scripts/check-destructive-migrations.py. It reads exactly the two top-level
 * keys named above and understands indentation, block scalars and comments,
 * which is what the awk version got wrong: `awk '/^volumes:/{found=1}'` never
 * stopped at the next top-level block, so any key added after `volumes:` would
 * have been counted as a volume name.
 *
 * The DEMO compose (packaging/electron/resources-demo/docker-compose.yml) is
 * deliberately NOT compared: it pins its own project name (`visiondemoapp`) so
 * its volumes stay isolated from real data.
 *
 * Usage (from anywhere):
 *   node scripts/check-compose-sync.js
 *   node scripts/check-compose-sync.js --self-test
 */
const { readFileSync } = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT_COMPOSE = 'docker-compose.yml';
const ELECTRON_COMPOSE = 'packaging/electron/resources/docker-compose.yml';

const KEY_RE = /^(\s*)([A-Za-z0-9_.-]+):(\s.*|)$/;
// `key: |`, `key: >-`, `key: |+2` … everything after the indicator is a block
// scalar whose *content* must never be read as YAML structure.
const BLOCK_SCALAR_RE = /^[|>][+-]?\d*$/;

/** Strip a trailing `# comment`, but only when it is not inside a quoted value. */
function stripInlineComment(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed;
  const hash = trimmed.search(/(^|\s)#/);
  return hash === -1 ? trimmed : trimmed.slice(0, hash).trim();
}

function unquote(value) {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Walk a compose file and return the structural bits this guard compares.
 *
 * Returns `{ name, volumes }` where `name` is the top-level project name (undefined
 * when absent) and `volumes` is the list of keys in the top-level `volumes:` mapping
 * (undefined when there is no such block — distinct from an empty block).
 */
function parseCompose(text, label) {
  const lines = String(text).split(/\r?\n/);
  let name;
  let volumes;
  let inVolumes = false;
  let volumeIndent; // indent of the first child key; deeper lines are that key's value
  let blockScalarIndent; // when set, skip every line indented deeper than this

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;

    if (blockScalarIndent !== undefined) {
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = undefined;
    }

    const match = KEY_RE.exec(line);

    if (indent === 0) {
      // Any top-level construct ends the volumes block — including a `---`
      // document break or a sequence item, not just another key.
      inVolumes = false;
      if (!match) continue;
      const key = match[2];
      const value = stripInlineComment(match[3]);
      if (BLOCK_SCALAR_RE.test(value)) blockScalarIndent = indent;
      if (key === 'name' && value !== '') name = unquote(value);
      if (key === 'volumes') {
        if (volumes !== undefined) {
          throw new Error(`${label}: two top-level 'volumes:' blocks — invalid compose file`);
        }
        volumes = [];
        inVolumes = true;
        volumeIndent = undefined;
      }
      continue;
    }

    if (!inVolumes) {
      if (match && BLOCK_SCALAR_RE.test(stripInlineComment(match[3]))) blockScalarIndent = indent;
      continue;
    }

    // Inside the top-level volumes mapping. Its direct children are the volume
    // names; anything indented deeper belongs to one of them (driver:, labels: …).
    if (volumeIndent === undefined) volumeIndent = indent;
    if (indent > volumeIndent) continue;
    if (!match) {
      throw new Error(`${label}: unexpected line ${i + 1} in the top-level 'volumes:' block: ${line.trim()}`);
    }
    const value = stripInlineComment(match[3]);
    if (BLOCK_SCALAR_RE.test(value)) blockScalarIndent = indent;
    volumes.push(match[2]);
  }

  return { name, volumes };
}

/**
 * Compare two parsed compose files. Returns an array of human-readable problems;
 * empty means in sync.
 */
function diffCompose(root, electron) {
  const problems = [];

  if (!root.name || !electron.name) {
    problems.push(
      "compose 'name:' missing — both files must pin the same project name " +
        `(root: ${root.name || '(none)'}, electron: ${electron.name || '(none)'})`,
    );
  } else if (root.name !== electron.name) {
    problems.push(
      `compose 'name:' out of sync — root '${root.name}' vs electron '${electron.name}'. ` +
        'Both files must pin the same project name (the shared vision_postgres_data ' +
        'volume depends on it).',
    );
  }

  if (root.volumes === undefined || electron.volumes === undefined) {
    problems.push(
      "no top-level 'volumes:' block found — " +
        `root: ${root.volumes === undefined ? 'missing' : 'present'}, ` +
        `electron: ${electron.volumes === undefined ? 'missing' : 'present'}`,
    );
    return problems;
  }

  const rootVols = [...root.volumes].sort();
  const electronVols = [...electron.volumes].sort();
  const missing = rootVols.filter((v) => !electronVols.includes(v));
  const extra = electronVols.filter((v) => !rootVols.includes(v));

  if (missing.length > 0) {
    problems.push(
      `named volumes missing from ${ELECTRON_COMPOSE}: ${missing.join(', ')} — ` +
        'add them before releasing (omitting one is what caused the v1.0.2 data loss).',
    );
  }
  if (extra.length > 0) {
    problems.push(
      `named volumes present only in ${ELECTRON_COMPOSE}: ${extra.join(', ')} — ` +
        `add them to ${ROOT_COMPOSE} or drop them from the packaged file.`,
    );
  }

  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-test — proves the checker discriminates, so a green CI run means the
// files agree rather than that the parser silently found nothing. Mirrors
// scripts/check-destructive-migrations.py --self-test.
// ─────────────────────────────────────────────────────────────────────────────
const SELF_TEST_ROOT = `# comment
name: vision
services:
  app:
    image: x
    volumes:
      - attachments_data:/app/data/attachments
      - ./docker/postgres-init:/docker-entrypoint-initdb.d:ro
    command: |
      volumes:
        not_a_volume:
volumes:
  postgres_data:
  attachments_data:
  vision_cache_data:
`;

function selfTest() {
  const cases = [];
  const check = (label, ok, detail) => cases.push({ label, ok, detail });

  const root = parseCompose(SELF_TEST_ROOT, 'self-test root');
  check(
    'parses project name',
    root.name === 'vision',
    `got ${JSON.stringify(root.name)}`,
  );
  check(
    'reads only the top-level volumes mapping (service mounts and block scalars ignored)',
    JSON.stringify(root.volumes) ===
      JSON.stringify(['postgres_data', 'attachments_data', 'vision_cache_data']),
    `got ${JSON.stringify(root.volumes)}`,
  );

  // The awk version's real bug: it never stopped at the next top-level block,
  // so keys under anything following `volumes:` were counted as volume names.
  const withTrailingBlock = parseCompose(
    `${SELF_TEST_ROOT}networks:\n  frontend:\n  backend:\n`,
    'self-test trailing block',
  );
  check(
    'stops at the next top-level block',
    JSON.stringify(withTrailingBlock.volumes) === JSON.stringify(root.volumes),
    `got ${JSON.stringify(withTrailingBlock.volumes)}`,
  );

  const nested = parseCompose(
    'name: vision\nvolumes:\n  postgres_data:\n    driver: local\n    driver_opts:\n      type: none\n  attachments_data:\n',
    'self-test nested',
  );
  check(
    'volume options are not mistaken for volume names',
    JSON.stringify(nested.volumes) === JSON.stringify(['postgres_data', 'attachments_data']),
    `got ${JSON.stringify(nested.volumes)}`,
  );

  check(
    'identical files pass',
    diffCompose(root, parseCompose(SELF_TEST_ROOT, 'x')).length === 0,
    'expected no problems',
  );

  const missingVolume = parseCompose(
    SELF_TEST_ROOT.replace('  attachments_data:\n  vision_cache_data:\n', '  vision_cache_data:\n'),
    'self-test missing volume',
  );
  check(
    'a volume missing from the packaged file is caught',
    diffCompose(root, missingVolume).some((p) => p.includes('attachments_data')),
    JSON.stringify(diffCompose(root, missingVolume)),
  );

  const extraVolume = parseCompose(`${SELF_TEST_ROOT}  stray_data:\n`, 'self-test extra volume');
  check(
    'a volume only in the packaged file is caught',
    diffCompose(root, extraVolume).some((p) => p.includes('stray_data')),
    JSON.stringify(diffCompose(root, extraVolume)),
  );

  const renamed = parseCompose(SELF_TEST_ROOT.replace('name: vision', 'name: vision2'), 'self-test rename');
  check(
    'a project-name change is caught',
    diffCompose(root, renamed).some((p) => p.includes("'name:' out of sync")),
    JSON.stringify(diffCompose(root, renamed)),
  );

  const unnamed = parseCompose(SELF_TEST_ROOT.replace('name: vision\n', ''), 'self-test unnamed');
  check(
    'a missing project name is caught',
    diffCompose(root, unnamed).some((p) => p.includes("'name:' missing")),
    JSON.stringify(diffCompose(root, unnamed)),
  );

  const noVolumes = parseCompose('name: vision\nservices:\n  app:\n    image: x\n', 'self-test no volumes');
  check(
    'a missing volumes block is caught',
    diffCompose(root, noVolumes).some((p) => p.includes("no top-level 'volumes:' block")),
    JSON.stringify(diffCompose(root, noVolumes)),
  );

  let failed = 0;
  for (const c of cases) {
    if (c.ok) {
      console.log(`  ok   ${c.label}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${c.label} — ${c.detail}`);
    }
  }
  if (failed > 0) {
    console.error(`[check-compose-sync] self-test: ${failed}/${cases.length} case(s) failed.`);
    process.exit(1);
  }
  console.log(`[check-compose-sync] self-test passed (${cases.length} cases).`);
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }

  const files = [ROOT_COMPOSE, ELECTRON_COMPOSE];
  let parsed;
  try {
    parsed = files.map((rel) => parseCompose(readFileSync(path.join(REPO_ROOT, rel), 'utf8'), rel));
  } catch (err) {
    console.error(`[check-compose-sync] ${err.message}`);
    process.exit(1);
  }

  const [root, electron] = parsed;
  console.log(`[check-compose-sync] ${ROOT_COMPOSE}    : name=${root.name} volumes=${(root.volumes || []).join(' ')}`);
  console.log(`[check-compose-sync] ${ELECTRON_COMPOSE}: name=${electron.name} volumes=${(electron.volumes || []).join(' ')}`);

  const problems = diffCompose(root, electron);
  if (problems.length > 0) {
    console.error('[check-compose-sync] ERROR: the packaged compose file is out of sync with the root one:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log('[check-compose-sync] in sync: project name and named volumes match.');
}

main();
