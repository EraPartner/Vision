#!/usr/bin/env node
/**
 * Point git at the version-controlled .githooks/ directory.
 *
 * Runs from the root `prepare` lifecycle script on `bun install`, and can be run
 * by hand: `bun run hooks:setup`. Idempotent and best-effort — it never fails an
 * install. A no-op when there is no git work tree to configure (CI shallow
 * checkouts that skip hooks, Docker builds where .git is not copied, tarball
 * installs), so it is safe to leave wired into `prepare`.
 *
 * Uses a relative path (".githooks") so it resolves correctly both on the host
 * and inside the devcontainer (where the repo is mounted at /workspaces/repo).
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOOKS_DIR = '.githooks';

function git(args) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function main() {
  try {
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return;
  } catch {
    return; // git missing, or not a repo — nothing to wire.
  }

  // Make the hook scripts executable (some checkouts/filesystems drop the bit).
  try {
    const dir = path.resolve(__dirname, '..', HOOKS_DIR);
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isFile()) fs.chmodSync(file, 0o755);
    }
  } catch {
    /* non-fatal */
  }

  let current = '';
  try {
    current = git(['config', '--local', '--get', 'core.hooksPath']);
  } catch {
    /* unset */
  }
  if (current === HOOKS_DIR) return;

  try {
    git(['config', 'core.hooksPath', HOOKS_DIR]);
    console.log(`[setup-git-hooks] core.hooksPath → ${HOOKS_DIR}`);
  } catch (err) {
    console.log(
      `[setup-git-hooks] could not set core.hooksPath (${err.message}); ` +
        `run "git config core.hooksPath ${HOOKS_DIR}" manually.`,
    );
  }
}

main();
